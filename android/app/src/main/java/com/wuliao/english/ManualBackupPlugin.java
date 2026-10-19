package com.wuliao.english;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.provider.DocumentsContract;
import android.util.Base64;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.OutputStream;
import java.security.MessageDigest;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Manual exports use their own document and never alter the updater state. */
@CapacitorPlugin(name = "ManualBackup")
public class ManualBackupPlugin extends Plugin {
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private volatile String id;
    private java.io.File temporary;
    private Uri uri;
    private OutputStream output;
    private MessageDigest digest;
    private long offset;
    private volatile boolean choosing;

    @PluginMethod public synchronized void begin(PluginCall call) {
        if (choosing || id != null) { call.reject("已有备份正在导出"); return; }
        choosing = true;
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("application/json");
        intent.putExtra(Intent.EXTRA_TITLE, call.getString("filename", "wuliao-backup.json").replaceAll("[\\\\/:*?\"<>|]", "_"));
        startActivityForResult(call, intent, "chosen");
    }

    @ActivityCallback private void chosen(PluginCall call, ActivityResult result) {
        if (call == null) { choosing = false; return; }
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) {
            choosing = false; call.reject("已取消保存备份", "cancelled"); return;
        }
        worker.execute(() -> {
            try {
                uri = result.getData().getData();
                java.io.File folder = new java.io.File(getContext().getCacheDir(), "manual-backups");
                if (!folder.isDirectory() && !folder.mkdirs()) throw new IllegalStateException("无法创建备份暂存区");
                temporary = java.io.File.createTempFile("backup-", ".part", folder);
                output = new java.io.FileOutputStream(temporary);
                if (output == null) throw new IllegalStateException("无法写入所选位置");
                digest = MessageDigest.getInstance("SHA-256"); offset = 0; id = UUID.randomUUID().toString();
                call.resolve(new JSObject().put("backupId", id));
            } catch (Exception error) { discard(); call.reject("无法创建备份文件", error); }
            finally { choosing = false; }
        });
    }

    private void check(PluginCall call) {
        if (id == null || !id.equals(call.getString("backupId")) || output == null) throw new IllegalStateException("备份任务已失效");
    }

    @PluginMethod public void write(PluginCall call) {
        worker.execute(() -> {
            try {
                check(call);
                if (BackupChunkPosition.read(call.getData().opt("offset")) != offset) throw new IllegalStateException("备份分块顺序错误");
                String data = call.getString("data", "");
                if (data.length() > 300000) throw new IllegalStateException("备份分块过大");
                byte[] bytes = Base64.decode(data, Base64.NO_WRAP);
                output.write(bytes); digest.update(bytes); offset += bytes.length; call.resolve();
            } catch (Exception error) { call.reject("备份分块写入失败：" + error.getMessage(), error); }
        });
    }

    @PluginMethod public void finish(PluginCall call) {
        worker.execute(() -> {
            try {
                check(call);
                StringBuilder hex = new StringBuilder();
                for (byte b : digest.digest()) hex.append(String.format(java.util.Locale.ROOT, "%02x", b & 255));
                if (!hex.toString().equals(call.getString("sha256"))) throw new IllegalStateException("备份文件校验失败");
                output.flush(); output.close(); output = null;
                try (java.io.InputStream input = new java.io.FileInputStream(temporary);
                     OutputStream document = getContext().getContentResolver().openOutputStream(uri, "wt")) {
                    if (document == null) throw new IllegalStateException("无法保存备份");
                    byte[] bytes = new byte[192 * 1024]; int count;
                    while ((count = input.read(bytes)) != -1) document.write(bytes, 0, count);
                    document.flush();
                }
                // Read back the saved document before reporting success.
                MessageDigest readHash = MessageDigest.getInstance("SHA-256"); long readSize = 0;
                try (java.io.InputStream input = getContext().getContentResolver().openInputStream(uri)) {
                    if (input == null) throw new IllegalStateException("无法回读备份");
                    byte[] bytes = new byte[192 * 1024]; int count;
                    while ((count = input.read(bytes)) != -1) { readHash.update(bytes, 0, count); readSize += count; }
                }
                StringBuilder actual = new StringBuilder();
                for (byte b : readHash.digest()) actual.append(String.format(java.util.Locale.ROOT, "%02x", b & 255));
                if (readSize != offset || !actual.toString().equals(hex.toString())) throw new IllegalStateException("备份回读校验失败");
                if (temporary != null) temporary.delete(); temporary = null;
                id = null; uri = null; digest = null;
                call.resolve(new JSObject().put("verified", true));
            } catch (Exception error) { discard(); call.reject("备份保存或校验失败：" + error.getMessage(), error); }
        });
    }

    @PluginMethod public void abort(PluginCall call) {
        worker.execute(() -> { if (id != null && id.equals(call.getString("backupId"))) discard(); call.resolve(); });
    }

    private void discard() {
        try { if (output != null) output.close(); } catch (Exception ignored) { }
        try { if (uri != null) DocumentsContract.deleteDocument(getContext().getContentResolver(), uri); } catch (Exception ignored) { }
        if (temporary != null) temporary.delete(); temporary = null;
        output = null; uri = null; id = null; digest = null;
    }

    @Override protected void handleOnDestroy() { worker.execute(this::discard); worker.shutdown(); }
}
