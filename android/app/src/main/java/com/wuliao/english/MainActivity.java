package com.wuliao.english;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.print.PrintJob;
import android.print.PrintManager;
import android.provider.MediaStore;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.util.Base64;
import android.util.Log;
import android.view.ActionMode;
import android.view.MotionEvent;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import android.widget.Toast;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;

import androidx.activity.OnBackPressedCallback;
import com.getcapacitor.BridgeActivity;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.Locale;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

import org.json.JSONObject;

public class MainActivity extends BridgeActivity {
    private AndroidSpeech androidSpeech;
    private volatile boolean suppressSelectionMenu = false;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        WebView webView = getBridge().getWebView();
        webView.setOnTouchListener((view, event) -> {
            int action = event.getActionMasked();
            if (action == MotionEvent.ACTION_DOWN || action == MotionEvent.ACTION_POINTER_DOWN) {
                int tool = event.getToolType(event.getActionIndex());
                if (tool == MotionEvent.TOOL_TYPE_STYLUS || tool == MotionEvent.TOOL_TYPE_ERASER) {
                    // Deliver real pen samples promptly; keep WebView's normal
                    // event handling and leave finger-only scrolling buffered.
                    view.requestUnbufferedDispatch(event);
                }
            }
            return false;
        });
        webView.addJavascriptInterface(
            new AndroidFileSaver(this),
            "AndroidFileSaver"
        );
        webView.addJavascriptInterface(
            new AndroidPdfExporter(this),
            "AndroidPdfExporter"
        );
        webView.addJavascriptInterface(
            new AndroidSecureStore(this),
            "AndroidSecureStore"
        );
        webView.addJavascriptInterface(
            new AndroidPrivateWritingSamples(this),
            "AndroidPrivateWritingSamples"
        );
        androidSpeech = new AndroidSpeech(this);
        webView.addJavascriptInterface(androidSpeech, "AndroidSpeech");
        webView.addJavascriptInterface(new AndroidSelectionUi(this), "WuliaoSelectionUi");
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                WebView webView = getBridge().getWebView();
                if (webView == null) {
                    moveTaskToBack(true);
                    return;
                }
                webView.evaluateJavascript(
                    "(window.__wuliaoHandleHardwareBack ? window.__wuliaoHandleHardwareBack() : false)",
                    value -> {
                        if (!"true".equals(value)) {
                            moveTaskToBack(true);
                        }
                    }
                );
            }
        });
    }

    @Override
    public void onActionModeStarted(ActionMode mode) {
        if (suppressSelectionMenu) {
            Log.i("WuliaoSelectionUi", "Suppressing selection action mode");
            mode.finish();
            return;
        }
        super.onActionModeStarted(mode);
    }

    private static final class AndroidSelectionUi {
        private final MainActivity activity;

        AndroidSelectionUi(MainActivity activity) {
            this.activity = activity;
        }

        @JavascriptInterface
        public void setSuppressSelectionMenu(boolean value) {
            activity.suppressSelectionMenu = value;
        }
    }

    private static final class AndroidSecureStore {
        private static final String PREF_NAME = "wuliao_secure_store";
        private static final String KEYSTORE = "AndroidKeyStore";
        private static final String KEY_ALIAS = "wuliao_secure_store_master";
        private final SharedPreferences preferences;

        AndroidSecureStore(Context context) {
            this.preferences = context.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE);
            ensureKey();
        }

        private void ensureKey() {
            try {
                KeyStore keyStore = KeyStore.getInstance(KEYSTORE);
                keyStore.load(null);
                if (keyStore.containsAlias(KEY_ALIAS)) return;
                KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE);
                generator.init(new KeyGenParameterSpec.Builder(
                    KEY_ALIAS,
                    KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT
                )
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(256)
                    .build());
                generator.generateKey();
            } catch (Exception ignored) {
                // 不写入明文；WebView 侧的 write/read-back 校验会阻止正式 AI 请求。
            }
        }

        private SecretKey loadKey() {
            try {
                KeyStore keyStore = KeyStore.getInstance(KEYSTORE);
                keyStore.load(null);
                return (SecretKey) keyStore.getKey(KEY_ALIAS, null);
            } catch (Exception ignored) {
                return null;
            }
        }

        @JavascriptInterface
        public String get(String key) {
            String stored = preferences.getString(String.valueOf(key), "");
            if (stored == null || stored.isEmpty()) return "";
            SecretKey secretKey = loadKey();
            if (secretKey == null) return "";
            try {
                String[] parts = stored.split(":", 2);
                if (parts.length != 2) return "";
                byte[] iv = Base64.decode(parts[0], Base64.NO_WRAP);
                byte[] ciphertext = Base64.decode(parts[1], Base64.NO_WRAP);
                Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
                cipher.init(Cipher.DECRYPT_MODE, secretKey, new GCMParameterSpec(128, iv));
                return new String(cipher.doFinal(ciphertext), StandardCharsets.UTF_8);
            } catch (Exception ignored) {
                return "";
            }
        }

        @JavascriptInterface
        public void set(String key, String value) {
            if (value == null || value.isEmpty()) {
                remove(key);
                return;
            }
            SecretKey secretKey = loadKey();
            if (secretKey == null) return;
            try {
                Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
                cipher.init(Cipher.ENCRYPT_MODE, secretKey);
                byte[] ciphertext = cipher.doFinal(String.valueOf(value).getBytes(StandardCharsets.UTF_8));
                String stored = Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP)
                    + ":" + Base64.encodeToString(ciphertext, Base64.NO_WRAP);
                preferences.edit().putString(String.valueOf(key), stored).apply();
            } catch (Exception ignored) {
                // 加密失败不写入明文。
            }
        }

        @JavascriptInterface
        public void remove(String key) {
            preferences.edit().remove(String.valueOf(key)).apply();
        }
    }

    private static final class AndroidPdfExporter {
        private final MainActivity activity;
        private PrintJob activeJob;
        private WebView activeWebView;
        private int pollAttempts;

        AndroidPdfExporter(MainActivity activity) {
            this.activity = activity;
        }

        @JavascriptInterface
        public void exportCurrentDocument(String requestedName) {
            activity.runOnUiThread(() -> {
                if (activeJob != null && !activeJob.isCompleted() && !activeJob.isCancelled() && !activeJob.isFailed()) {
                    dispatchResult(false, "", "已有 PDF 打印任务正在进行");
                    return;
                }
                try {
                    String fileName = safePdfFileName(requestedName);
                    WebView webView = activity.getBridge().getWebView();
                    PrintManager printManager = (PrintManager) activity.getSystemService(Context.PRINT_SERVICE);
                    if (printManager == null) throw new IllegalStateException("系统打印服务不可用");
                    PrintDocumentAdapter adapter = webView.createPrintDocumentAdapter(fileName.replaceFirst("(?i)\\.pdf$", ""));
                    PrintAttributes attributes = new PrintAttributes.Builder()
                        .setMediaSize(PrintAttributes.MediaSize.ISO_A4.asPortrait())
                        .setColorMode(PrintAttributes.COLOR_MODE_COLOR)
                        .setMinMargins(PrintAttributes.Margins.NO_MARGINS)
                        .build();
                    activeWebView = webView;
                    activeJob = printManager.print(fileName, adapter, attributes);
                    pollAttempts = 0;
                    Toast.makeText(activity, "请在系统打印界面选择“保存为 PDF”并确认位置", Toast.LENGTH_LONG).show();
                    webView.postDelayed(this::pollPrintJob, 500);
                } catch (Exception error) {
                    dispatchResult(false, "", error.getMessage() == null ? "无法启动系统打印" : error.getMessage());
                }
            });
        }

        private void pollPrintJob() {
            PrintJob job = activeJob;
            WebView webView = activeWebView;
            if (job == null || webView == null) return;
            if (job.isCompleted()) {
                finishJob(true, "系统打印服务所选位置", "");
                return;
            }
            if (job.isCancelled()) {
                finishJob(false, "", "已取消系统打印");
                return;
            }
            if (job.isFailed()) {
                finishJob(false, "", "系统打印任务失败");
                return;
            }
            pollAttempts += 1;
            if (pollAttempts >= 600) {
                finishJob(false, "", "系统打印任务尚未完成，请检查打印界面");
                return;
            }
            webView.postDelayed(this::pollPrintJob, 500);
        }

        private void finishJob(boolean success, String location, String message) {
            activeJob = null;
            activeWebView = null;
            pollAttempts = 0;
            dispatchResult(success, location, message);
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

    }

    private static final class AndroidPrivateWritingSamples {
        private static final String SEED_FILE = "writing-private-samples-seed.json";
        private static final int MAX_SEED_BYTES = 8 * 1024 * 1024;
        private final Context context;

        AndroidPrivateWritingSamples(Context context) {
            this.context = context.getApplicationContext();
        }

        private File seedFile() {
            return new File(context.getNoBackupFilesDir(), SEED_FILE);
        }

        @JavascriptInterface
        public String readPendingSeed() {
            File file = seedFile();
            long length = file.length();
            if (!file.isFile() || length <= 0 || length > MAX_SEED_BYTES) return "";
            byte[] bytes = new byte[(int) length];
            try (FileInputStream input = new FileInputStream(file)) {
                int offset = 0;
                while (offset < bytes.length) {
                    int count = input.read(bytes, offset, bytes.length - offset);
                    if (count < 0) return "";
                    offset += count;
                }
                return new String(bytes, StandardCharsets.UTF_8);
            } catch (Exception error) {
                Log.e("PrivateWritingSamples", "Unable to read pending seed", error);
                return "";
            }
        }

        @JavascriptInterface
        public boolean clearPendingSeed() {
            File file = seedFile();
            return !file.exists() || file.delete();
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
