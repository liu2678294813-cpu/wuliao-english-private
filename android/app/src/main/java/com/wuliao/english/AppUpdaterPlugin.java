package com.wuliao.english;

import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.util.Base64;
import androidx.activity.result.ActivityResult;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HashSet;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

@CapacitorPlugin(name = "AppUpdater")
public class AppUpdaterPlugin extends Plugin {
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final AtomicBoolean busy = new AtomicBoolean(false);
    private final AtomicBoolean cancelled = new AtomicBoolean(false);
    private volatile HttpURLConnection connection;
    private JSONObject release;
    private File apk;
    private File backupDir;
    private String backupId;
    private int backupAccounts;
    private final Set<Integer> verifiedAccounts = new HashSet<>();
    private boolean backupSealed;

    private interface Work { void run() throws Exception; }
    private void execute(PluginCall call, Work work) {
        worker.execute(() -> {
            try { work.run(); }
            catch (Exception error) {
                String message = cancelled.get() ? "更新已取消" : error instanceof SocketTimeoutException
                    ? "网络超时，请检查连接后重试" : error.getMessage();
                call.reject(message == null ? "更新失败，请重试" : message, cancelled.get() ? "cancelled" : "update_failed", error);
            }
        });
    }
    private void active() {
        if (cancelled.get()) throw new IllegalStateException("更新已取消");
    }
    private PackageInfo installed() throws Exception {
        int flags = Build.VERSION.SDK_INT >= 28 ? PackageManager.GET_SIGNING_CERTIFICATES : PackageManager.GET_SIGNATURES;
        return getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), flags);
    }
    private static long code(PackageInfo info) {
        return Build.VERSION.SDK_INT >= 28 ? info.getLongVersionCode() : info.versionCode;
    }
    private JSObject info() throws Exception {
        PackageInfo info = installed();
        return new JSObject().put("package", info.packageName).put("versionName", info.versionName)
            .put("versionCode", code(info)).put("sdk", Build.VERSION.SDK_INT);
    }
    @PluginMethod public void getInstalledInfo(PluginCall call) { execute(call, () -> call.resolve(info())); }

    private HttpURLConnection open(String address) throws Exception {
        URL url = new URL(address);
        for (int redirect = 0; redirect < 6; redirect++) {
            active();
            if (!AppUpdatePolicy.allowed(url)) throw new IllegalStateException("更新下载来源校验失败");
            HttpURLConnection request = (HttpURLConnection) url.openConnection();
            connection = request;
            request.setInstanceFollowRedirects(false);
            request.setConnectTimeout(15000);
            request.setReadTimeout(45000);
            request.setRequestProperty("User-Agent", "Wuliao-English-AppUpdater");
            request.setRequestProperty("Accept", "application/vnd.github+json");
            int status = request.getResponseCode();
            if (status == 301 || status == 302 || status == 303 || status == 307 || status == 308) {
                String location = request.getHeaderField("Location");
                request.disconnect();
                if (location == null) throw new IllegalStateException("下载重定向无效");
                url = new URL(url, location);
                continue;
            }
            if (status != 200) {
                request.disconnect();
                if (status == 403 || status == 429) throw new IllegalStateException("GitHub 暂时限制请求，请稍后重试");
                if (status == 404) throw new IllegalStateException("发布或安装包不存在，请稍后重试");
                throw new IllegalStateException("GitHub 请求失败（" + status + "），请重试");
            }
            return request;
        }
        throw new IllegalStateException("下载重定向次数过多");
    }
    private JSONObject json(String address) throws Exception {
        HttpURLConnection request = open(address);
        try (InputStream input = request.getInputStream(); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192]; int read;
            while ((read = input.read(buffer)) != -1) {
                active();
                if (output.size() + read > 1024 * 1024) throw new IllegalStateException("发布信息过大");
                output.write(buffer, 0, read);
            }
            return new JSONObject(output.toString("UTF-8"));
        } finally { request.disconnect(); connection = null; }
    }
    private JSONObject asset(JSONObject release, String name) throws Exception {
        JSONArray assets = release.getJSONArray("assets"); JSONObject match = null;
        for (int i = 0; i < assets.length(); i++) {
            JSONObject item = assets.getJSONObject(i);
            if (name.equals(item.getString("name"))) {
                if (match != null) throw new IllegalStateException("发布附件重复");
                match = item;
            }
        }
        if (match == null || !"uploaded".equals(match.optString("state"))) throw new IllegalStateException("发布附件缺失：" + name);
        if (!AppUpdatePolicy.releaseAsset(new URL(match.getString("browser_download_url")))) throw new IllegalStateException("发布附件来源无效");
        return match;
    }
    @PluginMethod public void checkLatest(PluginCall call) {
        if (!busy.compareAndSet(false, true)) { call.reject("更新正在处理中"); return; }
        cancelled.set(false);
        execute(call, () -> {
            try {
                release = null;
                JSONObject latest = json(AppUpdatePolicy.LATEST);
                if (latest.optBoolean("draft") || latest.optBoolean("prerelease")) throw new IllegalStateException("没有可用的正式版本");
                JSONObject metadata = json(asset(latest, "APK-metadata.json").getString("browser_download_url"));
                PackageInfo installed = installed();
                long latestCode = metadata.getLong("versionCode");
                if (!installed.packageName.equals(metadata.getString("package"))) throw new IllegalStateException("发布包名与当前应用不一致");
                if (latestCode <= code(installed)) {
                    call.resolve(new JSObject().put("available", false).put("installed", info()).put("versionName", metadata.getString("versionName")));
                    return;
                }
                AppUpdatePolicy.candidate(metadata.getString("package"), installed.packageName, latestCode, code(installed),
                    metadata.getInt("minSdkVersion"), Build.VERSION.SDK_INT, metadata.getString("contentVariant"),
                    metadata.getLong("apkBytes"), metadata.getString("apkSha256"));
                JSONObject apkAsset = asset(latest, metadata.getString("apkFileName"));
                if (apkAsset.getLong("size") != metadata.getLong("apkBytes")) throw new IllegalStateException("发布安装包大小不一致");
                String digest = apkAsset.optString("digest");
                if (!digest.isEmpty() && !digest.equals("sha256:" + metadata.getString("apkSha256"))) throw new IllegalStateException("发布校验值不一致");
                metadata.put("releaseId", latest.getLong("id")).put("url", apkAsset.getString("browser_download_url"))
                    .put("notes", latest.optString("body")).put("publishedAt", latest.getString("published_at"));
                release = metadata;
                call.resolve(new JSObject(metadata.toString()).put("available", true).put("installed", info()));
            } finally { busy.set(false); }
        });
    }
    private void readyRelease(PluginCall call) throws Exception {
        if (release == null || !String.valueOf(release.getLong("releaseId")).equals(call.getString("releaseId")))
            throw new IllegalStateException("请重新检查更新");
    }
    private void progress(long read, long total) {
        notifyListeners("downloadProgress", new JSObject().put("received", read).put("total", total));
    }
    private static String hex(byte[] bytes) {
        StringBuilder text = new StringBuilder();
        for (byte b : bytes) text.append(String.format(java.util.Locale.ROOT, "%02x", b & 255));
        return text.toString();
    }
    private static String sha(File file) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (InputStream input = new FileInputStream(file)) {
            byte[] buffer = new byte[65536]; int read;
            while ((read = input.read(buffer)) != -1) digest.update(buffer, 0, read);
        }
        return hex(digest.digest());
    }
    private Signature[] signatures(PackageInfo info) {
        return Build.VERSION.SDK_INT >= 28 ? info.signingInfo == null ? null : info.signingInfo.getApkContentsSigners() : info.signatures;
    }
    private String signer(Signature[] signatures) throws Exception {
        return signatures == null || signatures.length != 1 ? null : hex(MessageDigest.getInstance("SHA-256").digest(signatures[0].toByteArray()));
    }
    private void validateApk(File file) throws Exception {
        active();
        if (file == null || !file.isFile() || file.length() != release.getLong("apkBytes") || !sha(file).equals(release.getString("apkSha256")))
            throw new IllegalStateException("安装包校验失败，请重新下载");
        PackageInfo installed = installed();
        int flags = Build.VERSION.SDK_INT >= 28 ? PackageManager.GET_SIGNING_CERTIFICATES : PackageManager.GET_SIGNATURES;
        PackageInfo archive = getContext().getPackageManager().getPackageArchiveInfo(file.getAbsolutePath(), flags);
        if (archive == null || archive.applicationInfo == null) throw new IllegalStateException("安装包无效");
        AppUpdatePolicy.candidate(archive.packageName, installed.packageName, code(archive), code(installed),
            archive.applicationInfo.minSdkVersion, Build.VERSION.SDK_INT, "full", file.length(), sha(file));
        if (code(archive) != release.getLong("versionCode") || !archive.versionName.equals(release.getString("versionName")))
            throw new IllegalStateException("安装包版本与发布信息不一致");
        Signature[] signatures = signatures(archive);
        AppUpdatePolicy.signing(signer(signatures(installed)), signer(signatures), signatures == null ? 0 : signatures.length);
    }
    @PluginMethod public void downloadUpdate(PluginCall call) {
        if (!busy.compareAndSet(false, true)) { call.reject("更新正在处理中"); return; }
        cancelled.set(false); backupSealed = false;
        execute(call, () -> {
            File part = null;
            try {
                readyRelease(call);
                File folder = new File(getContext().getCacheDir(), "updates");
                if (!folder.isDirectory() && !folder.mkdirs()) throw new IllegalStateException("无法创建下载目录");
                long total = release.getLong("apkBytes");
                if (folder.getUsableSpace() < total + 32L * 1024 * 1024) throw new IllegalStateException("存储空间不足，请释放空间后重试");
                part = new File(folder, "update.apk.part");
                File complete = new File(folder, "update.apk");
                apk = null;
                HttpURLConnection request = open(release.getString("url"));
                try (InputStream input = request.getInputStream(); FileOutputStream output = new FileOutputStream(part)) {
                    byte[] buffer = new byte[65536]; int read; long received = 0, lastEvent = 0;
                    while ((read = input.read(buffer)) != -1) {
                        active(); received += read;
                        if (received > total) throw new IllegalStateException("下载大小超过发布信息");
                        output.write(buffer, 0, read);
                        long now = System.currentTimeMillis();
                        if (now - lastEvent > 250) { progress(received, total); lastEvent = now; }
                    }
                    output.getFD().sync();
                    progress(received, total);
                } finally { request.disconnect(); connection = null; }
                validateApk(part);
                if (complete.exists() && !complete.delete()) throw new IllegalStateException("无法替换旧缓存");
                if (!part.renameTo(complete)) throw new IllegalStateException("无法保存安装包");
                active(); apk = complete;
                call.resolve(new JSObject().put("verified", true));
            } finally {
                if (part != null) part.delete();
                busy.set(false);
            }
        });
    }
    @PluginMethod public void cancelDownload(PluginCall call) {
        cancelled.set(true); backupSealed = false;
        HttpURLConnection current = connection;
        if (current != null) current.disconnect();
        execute(call, () -> {
            if (apk != null) { apk.delete(); apk = null; }
            call.resolve();
        });
    }
    @PluginMethod public void beginBackup(PluginCall call) {
        execute(call, () -> {
            active(); if (apk == null) throw new IllegalStateException("安装包尚未校验");
            Integer count = call.getInt("accounts");
            if (count == null || count < 1 || count > 10000) throw new IllegalStateException("账号备份数量无效");
            backupId = UUID.randomUUID().toString(); backupAccounts = count; verifiedAccounts.clear(); backupSealed = false;
            backupDir = new File(getContext().getFilesDir(), "update-backups/" + backupId);
            if (!backupDir.mkdirs()) throw new IllegalStateException("无法创建本机备份");
            call.resolve(new JSObject().put("backupId", backupId));
        });
    }
    private File accountFile(PluginCall call) throws Exception {
        active();
        Integer index = call.getInt("accountIndex");
        if (backupId == null || !backupId.equals(call.getString("backupId")) || index == null || index < 0 || index >= backupAccounts || backupSealed)
            throw new IllegalStateException("更新备份任务无效");
        return new File(backupDir, "account-" + index + ".json");
    }
    @PluginMethod public void writeBackupChunk(PluginCall call) {
        execute(call, () -> {
            File file = accountFile(call);
            byte[] bytes = Base64.decode(call.getString("data", ""), Base64.NO_WRAP);
            // JSON offsets below 2^31 arrive as Integer, while PluginCall.getLong
            // only accepts Long. JSONObject reads both numeric representations.
            if (bytes.length == 0 || bytes.length > 256 * 1024 || file.length() != call.getData().optLong("offset", -1L)) throw new IllegalStateException("备份分块顺序无效");
            if (backupDir.getUsableSpace() < bytes.length + 16L * 1024 * 1024) throw new IllegalStateException("备份空间不足，已停止安装");
            verifiedAccounts.remove(call.getInt("accountIndex"));
            try (FileOutputStream output = new FileOutputStream(file, true)) { output.write(bytes); output.getFD().sync(); }
            call.resolve();
        });
    }
    @PluginMethod public void finishBackupAccount(PluginCall call) {
        execute(call, () -> {
            File file = accountFile(call);
            if (!sha(file).equals(call.getString("sha256"))) throw new IllegalStateException("本机备份回读校验失败，已停止安装");
            verifiedAccounts.add(call.getInt("accountIndex"));
            call.resolve(new JSObject().put("verified", true));
        });
    }
    @PluginMethod public void finishBackup(PluginCall call) {
        execute(call, () -> {
            active();
            if (backupId == null || !backupId.equals(call.getString("backupId")) || verifiedAccounts.size() != backupAccounts) throw new IllegalStateException("全账号备份尚未完成");
            JSONObject receipt = new JSONObject().put("targetVersionCode", release.getLong("versionCode")).put("accounts", backupAccounts).put("createdAt", System.currentTimeMillis());
            try (FileOutputStream output = new FileOutputStream(new File(backupDir, "verified.json"))) {
                output.write(receipt.toString().getBytes(StandardCharsets.UTF_8)); output.getFD().sync();
            }
            backupSealed = true;
            call.resolve(new JSObject().put("verified", true));
        });
    }
    @PluginMethod public void installUpdate(PluginCall call) {
        execute(call, () -> {
            active();
            if (!backupSealed) throw new IllegalStateException("更新前备份未完成，已停止安装");
            validateApk(apk);
            getActivity().runOnUiThread(() -> {
                try {
                    if (Build.VERSION.SDK_INT >= 26 && !getContext().getPackageManager().canRequestPackageInstalls()) {
                        Intent intent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getContext().getPackageName()));
                        startActivityForResult(call, intent, "permissionResult");
                    } else launchInstaller(call);
                } catch (Exception error) { call.reject("无法打开系统安装界面", "installer_failed", error); }
            });
        });
    }
    @ActivityCallback private void permissionResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (!cancelled.get() && Build.VERSION.SDK_INT >= 26 && getContext().getPackageManager().canRequestPackageInstalls()) {
            // Repeat the checksum and version checks after returning from Settings.
            installUpdate(call);
        } else call.resolve(new JSObject().put("status", "permission-denied"));
    }
    private void launchInstaller(PluginCall call) throws Exception {
        active();
        Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", apk);
        Intent intent = new Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION).putExtra(Intent.EXTRA_RETURN_RESULT, true);
        startActivityForResult(call, intent, "installationResult");
    }
    @ActivityCallback private void installationResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        execute(call, () -> call.resolve(new JSObject().put("status", code(installed()) >= release.getLong("versionCode") ? "installed" : "cancelled").put("installed", info())));
    }
    @Override protected void handleOnDestroy() {
        cancelled.set(true);
        if (connection != null) connection.disconnect();
        worker.shutdownNow();
    }
}
