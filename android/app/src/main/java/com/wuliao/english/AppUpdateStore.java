package com.wuliao.english;

import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageInstaller;
import android.os.Build;
import android.os.Parcel;
import android.util.Base64;
import org.json.JSONObject;
import java.io.File;
import java.io.FileInputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

/** Durable installation journal, separate from all account learning databases. */
final class AppUpdateStore {
    static final Object LOCK = new Object();
    static String resultAction(Context context) { return context.getPackageName() + ".UPDATE_RESULT"; }
    static String changeAction(Context context) { return context.getPackageName() + ".UPDATE_CHANGED"; }

    static JSONObject read(Context context) throws Exception {
        return new JSONObject(context.getSharedPreferences("app-update-state", Context.MODE_PRIVATE).getString("journal", "{\"status\":\"idle\"}"));
    }
    static void write(Context context, JSONObject state) throws Exception {
        if (!context.getSharedPreferences("app-update-state", Context.MODE_PRIVATE).edit().putString("journal", state.toString()).commit())
            throw new IllegalStateException("无法保存更新状态，已停止安装");
    }
    static long installedCode(Context context) throws Exception {
        PackageInfo info = context.getPackageManager().getPackageInfo(context.getPackageName(), 0);
        return Build.VERSION.SDK_INT >= 28 ? info.getLongVersionCode() : info.versionCode;
    }
    static boolean installing(JSONObject state) {
        String status = state.optString("status");
        return "submitted".equals(status) || "pending-user-action".equals(status) || "permission-required".equals(status) || "ready".equals(status);
    }
    static String hash(File file) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (FileInputStream input = new FileInputStream(file)) {
            byte[] buffer = new byte[65536]; int count;
            while ((count = input.read(buffer)) != -1) digest.update(buffer, 0, count);
        }
        StringBuilder result = new StringBuilder();
        for (byte value : digest.digest()) result.append(String.format(java.util.Locale.ROOT, "%02x", value & 255));
        return result.toString();
    }
    static JSONObject receipt(File directory) throws Exception {
        File file = new File(directory, "verified.json");
        if (!file.isFile() || file.length() > 2 * 1024 * 1024) return null;
        try (FileInputStream input = new FileInputStream(file)) {
            byte[] data = new byte[(int) file.length()]; int offset = 0, count;
            while (offset < data.length && (count = input.read(data, offset, data.length - offset)) != -1) offset += count;
            if (offset != data.length) return null;
            return new JSONObject(new String(data, StandardCharsets.UTF_8));
        }
    }
    static boolean verifiedBackup(File directory) throws Exception {
        JSONObject receipt;
        try { receipt = receipt(directory); } catch (org.json.JSONException invalid) { return false; }
        if (receipt == null || receipt.optInt("accounts") < 1 || receipt.optInt("accounts") > 10000 || receipt.optLong("targetVersionCode") < 1) return false;
        JSONObject hashes = receipt.optJSONObject("sha256");
        for (int index = 0; index < receipt.getInt("accounts"); index++) {
            File file = new File(directory, "account-" + index + ".json");
            if (!file.getCanonicalFile().getParentFile().equals(directory.getCanonicalFile()) || !file.isFile() || file.length() == 0) return false;
            // Legacy seals were created only after frontend parse and native readback.
            // New seals additionally persist every digest for restart-time verification.
            if (hashes != null && !hash(file).equals(hashes.optString(String.valueOf(index)))) return false;
        }
        return true;
    }
    static File prune(Context context, File candidate) throws Exception {
        return UpdateFiles.pruneBackups(new File(context.getFilesDir(), "update-backups"), candidate, AppUpdateStore::verifiedBackup);
    }
    static void cleanup(Context context) throws Exception {
        UpdateFiles.clearDownloads(context.getCacheDir());
        prune(context, null);
    }
    static JSONObject reconcile(Context context) throws Exception {
        synchronized (LOCK) {
            JSONObject state = read(context);
            long target = state.optLong("targetVersionCode");
            if (target > 0 && installedCode(context) >= target) {
                state.put("status", "installed").put("message", "更新已完成");
                state.remove("confirmation");
                write(context, state);
                cleanup(context);
            } else if ("installed".equals(state.optString("status"))) {
                state.put("status", "failed").put("message", "系统返回成功，但实际版本未更新，请重试");
                write(context, state); cleanup(context);
            } else if (installing(state) && state.optInt("sessionId", -1) >= 0
                && context.getPackageManager().getPackageInstaller().getSessionInfo(state.getInt("sessionId")) == null) {
                state.put("status", "cancelled").put("message", "未完成安装，原版本仍保留。");
                state.remove("confirmation");
                write(context, state); cleanup(context);
            }
            return state;
        }
    }
    static String encodeIntent(Intent intent) {
        Parcel parcel = Parcel.obtain();
        try { intent.writeToParcel(parcel, 0); return Base64.encodeToString(parcel.marshall(), Base64.NO_WRAP); }
        finally { parcel.recycle(); }
    }
    static Intent decodeIntent(String encoded) {
        Parcel parcel = Parcel.obtain();
        try {
            byte[] data = Base64.decode(encoded, Base64.NO_WRAP);
            parcel.unmarshall(data, 0, data.length); parcel.setDataPosition(0);
            return Intent.CREATOR.createFromParcel(parcel);
        } finally { parcel.recycle(); }
    }
}
