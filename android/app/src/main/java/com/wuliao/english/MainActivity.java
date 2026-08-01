package com.wuliao.english;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Rect;
import android.graphics.Typeface;
import android.graphics.pdf.PdfDocument;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelFileDescriptor;
import android.provider.MediaStore;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.util.Base64;
import android.util.Log;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import android.view.PixelCopy;
import android.widget.Toast;

import com.getcapacitor.BridgeActivity;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.util.Locale;

import org.json.JSONObject;

public class MainActivity extends BridgeActivity {
    private AndroidSpeech androidSpeech;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        WebView.enableSlowWholeDocumentDraw();
        super.onCreate(savedInstanceState);
        getBridge().getWebView().addJavascriptInterface(
            new AndroidFileSaver(this),
            "AndroidFileSaver"
        );
        getBridge().getWebView().addJavascriptInterface(
            new AndroidPdfExporter(this),
            "AndroidPdfExporter"
        );
        androidSpeech = new AndroidSpeech(this);
        getBridge().getWebView().addJavascriptInterface(androidSpeech, "AndroidSpeech");
    }

    private static final class AndroidPdfExporter {
        private final MainActivity activity;

        AndroidPdfExporter(MainActivity activity) {
            this.activity = activity;
        }

        @JavascriptInterface
        public void exportCurrentDocument(String requestedName) {
            activity.runOnUiThread(() -> {
                WebView webView = activity.getBridge().getWebView();
                webView.evaluateJavascript(
                    "(()=>{document.documentElement.classList.add('native-pdf-export');"
                        + "void document.documentElement.offsetHeight;"
                        + "const content=document.querySelector('.deep-reader-content');"
                        + "const top=content ? content.getBoundingClientRect().top + window.scrollY : 0;"
                        + "const bottom=content ? content.getBoundingClientRect().bottom + window.scrollY : document.documentElement.scrollHeight;"
                        + "return {contentTop:Math.max(0,top),contentHeight:Math.max(1,bottom-top),"
                        + "viewportHeight:window.innerHeight,originalScrollY:window.scrollY};})()",
                    setupJson -> {
                        try {
                            JSONObject setup = new JSONObject(setupJson);
                            String fileName = safePdfFileName(requestedName);
                            PdfTarget target = createPdfTarget(activity, fileName);
                            PdfExportSession session = new PdfExportSession(
                                webView,
                                target,
                                setup.optDouble("contentTop", 0),
                                setup.optDouble("contentHeight", 1),
                                setup.optDouble("viewportHeight", 1),
                                setup.optDouble("originalScrollY", 0)
                            );
                            webView.postDelayed(session::captureNextPage, 180);
                        } catch (Exception error) {
                            cleanupExportLayout(webView, 0);
                            dispatchResult(false, "", error.getMessage());
                        }
                    }
                );
            });
        }

        private final class PdfExportSession {
            final int pageWidth = 595;
            final int pageHeight = 842;
            final int margin = 28;
            final WebView webView;
            final PdfTarget target;
            final double contentTop;
            final double viewportHeight;
            final double originalScrollY;
            final boolean originalVerticalScrollBar;
            final boolean originalHorizontalScrollBar;
            final int pageCount;
            final PdfDocument document = new PdfDocument();
            int pageIndex;

            PdfExportSession(
                WebView webView,
                PdfTarget target,
                double contentTop,
                double contentHeight,
                double viewportHeight,
                double originalScrollY
            ) {
                this.webView = webView;
                this.target = target;
                this.contentTop = contentTop;
                this.viewportHeight = Math.max(1, viewportHeight);
                this.originalScrollY = originalScrollY;
                this.pageCount = Math.max(1, (int) Math.ceil(contentHeight / this.viewportHeight));
                this.originalVerticalScrollBar = webView.isVerticalScrollBarEnabled();
                this.originalHorizontalScrollBar = webView.isHorizontalScrollBarEnabled();
                webView.setVerticalScrollBarEnabled(false);
                webView.setHorizontalScrollBarEnabled(false);
            }

            void captureNextPage() {
                if (pageIndex >= pageCount) {
                    finishSuccess();
                    return;
                }
                double scrollTarget = contentTop + pageIndex * viewportHeight;
                webView.evaluateJavascript(
                    "window.scrollTo(0," + scrollTarget + ");window.scrollY;",
                    ignored -> webView.postDelayed(this::drawCurrentViewport, 95)
                );
            }

            private void drawCurrentViewport() {
                try {
                    int viewWidth = webView.getWidth();
                    int viewHeight = webView.getHeight();
                    if (viewWidth <= 0 || viewHeight <= 0) {
                        throw new IllegalStateException("页面尚未完成排版，请稍后重试");
                    }
                    Bitmap bitmap = Bitmap.createBitmap(
                        viewWidth,
                        viewHeight,
                        Bitmap.Config.ARGB_8888
                    );
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                        int[] location = new int[2];
                        webView.getLocationInWindow(location);
                        Rect source = new Rect(
                            location[0],
                            location[1],
                            location[0] + viewWidth,
                            location[1] + viewHeight
                        );
                        PixelCopy.request(
                            activity.getWindow(),
                            source,
                            bitmap,
                            result -> {
                                if (result != PixelCopy.SUCCESS) {
                                    bitmap.recycle();
                                    finishFailure(new IllegalStateException("页面截图失败：" + result));
                                    return;
                                }
                                drawBitmapPage(bitmap);
                            },
                            new Handler(Looper.getMainLooper())
                        );
                        return;
                    }
                    webView.draw(new Canvas(bitmap));
                    drawBitmapPage(bitmap);
                } catch (Exception error) {
                    finishFailure(error);
                }
            }

            private void drawBitmapPage(Bitmap bitmap) {
                try {
                    PdfDocument.PageInfo info = new PdfDocument.PageInfo.Builder(
                        pageWidth,
                        pageHeight,
                        pageIndex + 1
                    ).create();
                    PdfDocument.Page page = document.startPage(info);
                    Canvas canvas = page.getCanvas();
                    canvas.drawColor(Color.WHITE);
                    float availableWidth = pageWidth - margin * 2f;
                    float availableHeight = pageHeight - margin * 2f;
                    int viewWidth = bitmap.getWidth();
                    int viewHeight = bitmap.getHeight();
                    float scale = Math.min(availableWidth / viewWidth, availableHeight / viewHeight);
                    float left = margin + (availableWidth - viewWidth * scale) / 2f;
                    float top = margin + (availableHeight - viewHeight * scale) / 2f;
                    int contentSave = canvas.save();
                    canvas.clipRect(margin, margin, pageWidth - margin, pageHeight - margin);
                    canvas.translate(left, top);
                    canvas.scale(scale, scale);
                    canvas.drawBitmap(bitmap, 0, 0, new Paint(Paint.ANTI_ALIAS_FLAG | Paint.FILTER_BITMAP_FLAG));
                    canvas.restoreToCount(contentSave);
                    drawWatermark(canvas, pageWidth, pageHeight);
                    document.finishPage(page);
                    bitmap.recycle();
                    pageIndex += 1;
                    webView.post(this::captureNextPage);
                } catch (Exception error) {
                    if (!bitmap.isRecycled()) bitmap.recycle();
                    finishFailure(error);
                }
            }

            private void finishSuccess() {
                try {
                    cleanupExportLayout(webView, originalScrollY);
                    restoreScrollBars();
                    try (FileOutputStream output = new FileOutputStream(target.descriptor.getFileDescriptor())) {
                        document.writeTo(output);
                        output.flush();
                    }
                    document.close();
                    finishTarget(target, true);
                    dispatchResult(true, target.location, "");
                } catch (Exception error) {
                    finishFailure(error);
                }
            }

            private void finishFailure(Exception error) {
                try {
                    document.close();
                } catch (Exception ignored) {
                    // Best-effort cleanup after a failed page capture.
                }
                cleanupExportLayout(webView, originalScrollY);
                restoreScrollBars();
                finishTarget(target, false);
                dispatchResult(
                    false,
                    "",
                    error.getMessage() == null ? "生成失败" : error.getMessage()
                );
            }

            private void restoreScrollBars() {
                webView.setVerticalScrollBarEnabled(originalVerticalScrollBar);
                webView.setHorizontalScrollBarEnabled(originalHorizontalScrollBar);
            }
        }

        private static void cleanupExportLayout(WebView webView, double originalScrollY) {
            webView.evaluateJavascript(
                "document.documentElement.classList.remove('native-pdf-export');"
                    + "window.scrollTo(0," + Math.max(0, originalScrollY) + ");",
                null
            );
        }

        private static void drawWatermark(Canvas canvas, int pageWidth, int pageHeight) {
            Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
            paint.setColor(Color.rgb(16, 46, 78));
            paint.setAlpha(26);
            paint.setTextSize(18f);
            paint.setTypeface(Typeface.create(Typeface.SANS_SERIF, Typeface.BOLD));
            paint.setTextAlign(Paint.Align.CENTER);
            int save = canvas.save();
            canvas.rotate(-32f, pageWidth / 2f, pageHeight / 2f);
            for (float y = -pageHeight; y < pageHeight * 2f; y += 105f) {
                for (float x = -pageWidth; x < pageWidth * 2f; x += 185f) {
                    canvas.drawText("无聊英语app", x, y, paint);
                }
            }
            canvas.restoreToCount(save);
        }

        private void dispatchResult(boolean success, String location, String message) {
            String script = "window.dispatchEvent(new CustomEvent('wuliao-pdf-export-result',{detail:{success:"
                + success
                + ",location:"
                + JSONObject.quote(location == null ? "" : location)
                + ",message:"
                + JSONObject.quote(message == null ? "" : message)
                + "}}));";
            activity.getBridge().getWebView().evaluateJavascript(script, null);
            Toast.makeText(
                activity,
                success ? "精读成品已保存到：" + location : "PDF 导出失败：" + message,
                Toast.LENGTH_LONG
            ).show();
        }

        private static String safePdfFileName(String requestedName) {
            String fileName = requestedName == null ? "" : requestedName
                .replaceAll("[\\\\/:*?\"<>|]", "_")
                .trim();
            if (fileName.isEmpty()) fileName = "精读成品.pdf";
            if (!fileName.toLowerCase().endsWith(".pdf")) fileName += ".pdf";
            return fileName;
        }

        private static PdfTarget createPdfTarget(Context context, String fileName) throws Exception {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ContentResolver resolver = context.getContentResolver();
                ContentValues values = new ContentValues();
                values.put(MediaStore.MediaColumns.DISPLAY_NAME, fileName);
                values.put(MediaStore.MediaColumns.MIME_TYPE, "application/pdf");
                values.put(
                    MediaStore.MediaColumns.RELATIVE_PATH,
                    Environment.DIRECTORY_DOWNLOADS + File.separator + "无聊英语"
                );
                values.put(MediaStore.MediaColumns.IS_PENDING, 1);
                Uri uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                if (uri == null) throw new IllegalStateException("无法创建 PDF 文件");
                ParcelFileDescriptor descriptor = resolver.openFileDescriptor(uri, "w");
                if (descriptor == null) {
                    resolver.delete(uri, null, null);
                    throw new IllegalStateException("无法写入 PDF 文件");
                }
                return new PdfTarget(
                    uri,
                    descriptor,
                    null,
                    "Download/无聊英语/" + fileName,
                    resolver
                );
            }

            File directory = context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
            if (directory == null) throw new IllegalStateException("下载目录不可用");
            if (!directory.exists() && !directory.mkdirs()) throw new IllegalStateException("无法创建下载目录");
            File file = new File(directory, fileName);
            ParcelFileDescriptor descriptor = ParcelFileDescriptor.open(
                file,
                ParcelFileDescriptor.MODE_CREATE
                    | ParcelFileDescriptor.MODE_TRUNCATE
                    | ParcelFileDescriptor.MODE_WRITE_ONLY
            );
            return new PdfTarget(null, descriptor, file, file.getAbsolutePath(), null);
        }

        private static void finishTarget(PdfTarget target, boolean success) {
            try {
                target.descriptor.close();
            } catch (Exception ignored) {
                // The print adapter may already have closed the descriptor.
            }
            if (target.uri != null && target.resolver != null) {
                if (!success) {
                    target.resolver.delete(target.uri, null, null);
                    return;
                }
                ContentValues values = new ContentValues();
                values.put(MediaStore.MediaColumns.IS_PENDING, 0);
                target.resolver.update(target.uri, values, null, null);
            } else if (!success && target.file != null && target.file.exists()) {
                target.file.delete();
            }
        }

        private static final class PdfTarget {
            final Uri uri;
            final ParcelFileDescriptor descriptor;
            final File file;
            final String location;
            final ContentResolver resolver;

            PdfTarget(
                Uri uri,
                ParcelFileDescriptor descriptor,
                File file,
                String location,
                ContentResolver resolver
            ) {
                this.uri = uri;
                this.descriptor = descriptor;
                this.file = file;
                this.location = location;
                this.resolver = resolver;
            }
        }
    }

    @Override
    public void onDestroy() {
        if (androidSpeech != null) androidSpeech.shutdown();
        super.onDestroy();
    }

    private static final class AndroidSpeech implements TextToSpeech.OnInitListener {
        private final MainActivity activity;
        private TextToSpeech textToSpeech;
        private boolean ready;
        private String pendingText = "";

        AndroidSpeech(MainActivity activity) {
            this.activity = activity;
            textToSpeech = new TextToSpeech(activity.getApplicationContext(), this);
        }

        @Override
        public void onInit(int status) {
            if (status != TextToSpeech.SUCCESS || textToSpeech == null) {
                Log.e("WuliaoSpeech", "TTS initialization failed: " + status);
                return;
            }
            int languageResult = textToSpeech.setLanguage(Locale.US);
            if (languageResult == TextToSpeech.LANG_MISSING_DATA
                || languageResult == TextToSpeech.LANG_NOT_SUPPORTED) {
                languageResult = textToSpeech.setLanguage(Locale.ENGLISH);
            }
            ready = languageResult != TextToSpeech.LANG_MISSING_DATA
                && languageResult != TextToSpeech.LANG_NOT_SUPPORTED;
            textToSpeech.setSpeechRate(0.86f);
            textToSpeech.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                @Override
                public void onStart(String utteranceId) {
                    Log.i("WuliaoSpeech", "started " + utteranceId);
                }

                @Override
                public void onDone(String utteranceId) {
                    Log.i("WuliaoSpeech", "completed " + utteranceId);
                }

                @Override
                public void onError(String utteranceId) {
                    Log.e("WuliaoSpeech", "failed " + utteranceId);
                }
            });
            Log.i("WuliaoSpeech", ready ? "English TTS ready" : "English TTS unavailable");
            if (ready && !pendingText.isEmpty()) {
                String text = pendingText;
                pendingText = "";
                speakOnMainThread(text);
            }
        }

        @JavascriptInterface
        public void speak(String requestedText) {
            String text = requestedText == null ? "" : requestedText.trim();
            if (text.isEmpty() || text.length() > 120) return;
            activity.runOnUiThread(() -> {
                if (!ready || textToSpeech == null) {
                    pendingText = text;
                    return;
                }
                speakOnMainThread(text);
            });
        }

        @JavascriptInterface
        public void stop() {
            activity.runOnUiThread(() -> {
                pendingText = "";
                if (textToSpeech != null) textToSpeech.stop();
            });
        }

        private void speakOnMainThread(String text) {
            int result = textToSpeech.speak(
                text,
                TextToSpeech.QUEUE_FLUSH,
                null,
                "wuliao-word"
            );
            if (result == TextToSpeech.ERROR) {
                Log.e("WuliaoSpeech", "speak request rejected");
            }
        }

        void shutdown() {
            pendingText = "";
            if (textToSpeech != null) {
                textToSpeech.stop();
                textToSpeech.shutdown();
                textToSpeech = null;
            }
            ready = false;
        }
    }

    private static final class AndroidFileSaver {
        private final MainActivity activity;

        AndroidFileSaver(MainActivity activity) {
            this.activity = activity;
        }

        @JavascriptInterface
        public void saveBase64(String requestedName, String mimeType, String base64Data) {
            new Thread(() -> {
                try {
                    String fileName = safeFileName(requestedName);
                    byte[] bytes = Base64.decode(base64Data, Base64.DEFAULT);
                    String savedLocation = saveToDownloads(activity, fileName, mimeType, bytes);
                    activity.runOnUiThread(() -> Toast.makeText(
                        activity,
                        "已保存到下载目录：" + savedLocation,
                        Toast.LENGTH_LONG
                    ).show());
                } catch (Exception error) {
                    activity.runOnUiThread(() -> Toast.makeText(
                        activity,
                        "PDF 保存失败：" + error.getMessage(),
                        Toast.LENGTH_LONG
                    ).show());
                }
            }).start();
        }

        private static String safeFileName(String requestedName) {
            String fileName = requestedName == null ? "" : requestedName
                .replaceAll("[\\\\/:*?\"<>|]", "_")
                .trim();
            if (fileName.isEmpty()) fileName = "词库.pdf";
            if (!fileName.toLowerCase().endsWith(".pdf")) fileName += ".pdf";
            return fileName;
        }

        private static String saveToDownloads(
            Context context,
            String fileName,
            String mimeType,
            byte[] bytes
        ) throws Exception {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ContentResolver resolver = context.getContentResolver();
                ContentValues values = new ContentValues();
                values.put(MediaStore.MediaColumns.DISPLAY_NAME, fileName);
                values.put(
                    MediaStore.MediaColumns.MIME_TYPE,
                    mimeType == null || mimeType.isEmpty() ? "application/pdf" : mimeType
                );
                values.put(
                    MediaStore.MediaColumns.RELATIVE_PATH,
                    Environment.DIRECTORY_DOWNLOADS + File.separator + "无聊英语"
                );
                values.put(MediaStore.MediaColumns.IS_PENDING, 1);
                Uri uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                if (uri == null) throw new IllegalStateException("无法创建下载文件");
                try (OutputStream output = resolver.openOutputStream(uri)) {
                    if (output == null) throw new IllegalStateException("无法写入下载文件");
                    output.write(bytes);
                } catch (Exception error) {
                    resolver.delete(uri, null, null);
                    throw error;
                }
                values.clear();
                values.put(MediaStore.MediaColumns.IS_PENDING, 0);
                resolver.update(uri, values, null, null);
                return "Download/无聊英语/" + fileName;
            }

            File directory = context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
            if (directory == null) throw new IllegalStateException("下载目录不可用");
            if (!directory.exists() && !directory.mkdirs()) {
                throw new IllegalStateException("无法创建下载目录");
            }
            File outputFile = new File(directory, fileName);
            try (OutputStream output = new FileOutputStream(outputFile)) {
                output.write(bytes);
            }
            return outputFile.getAbsolutePath();
        }
    }
}
