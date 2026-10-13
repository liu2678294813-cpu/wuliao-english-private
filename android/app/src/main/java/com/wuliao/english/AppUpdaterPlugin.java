package com.wuliao.english;

import android.content.Intent;
import android.content.IntentFilter;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.app.PendingIntent;
import android.content.pm.PackageInstaller;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.util.Base64;
import androidx.activity.result.ActivityResult;
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
    private JSONObject backupHashes = new JSONObject();
    private volatile boolean resumed;
    private BroadcastReceiver stateReceiver;

    @Override public void load() {
        stateReceiver = new BroadcastReceiver() {
            @Override public void onReceive(Context context, Intent intent) { refreshState(true); }
        };
        IntentFilter filter = new IntentFilter(AppUpdateStore.changeAction(getContext()));
        if (Build.VERSION.SDK_INT >= 33) getContext().registerReceiver(stateReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
        else getContext().registerReceiver(stateReceiver, filter);
        worker.execute(() -> {
            try {
                JSONObject state = AppUpdateStore.reconcile(getContext());
                if (AppUpdateStore.installing(state)) {
                    release = state.optJSONObject("release");
                    apk = new File(getContext().getCacheDir(), "updates/update.apk");
                    String id = state.optString("backupId");
                    if (id.matches("[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}")) {
                        backupDir = new File(getContext().getFilesDir(), "update-backups/" + id);
                        backupId = id;
                        backupSealed = AppUpdateStore.verifiedBackup(backupDir);
                    }
                    AppUpdateStore.prune(getContext(), null);
                } else {
                    AppUpdateStore.cleanup(getContext());
                    if ("downloaded".equals(state.optString("status")) || "backing-up".equals(state.optString("status"))) {
                        state.put("status", "failed").put("message", "上次更新已中断，原数据保留，请重试");
                        AppUpdateStore.write(getContext(), state);
                    }
                }
            } catch (Exception error) { android.util.Log.e("WuliaoUpdater", "Update recovery failed", error); }
        });
    }
    private void stage(String status) throws Exception {
        synchronized (AppUpdateStore.LOCK) {
            JSONObject state = AppUpdateStore.read(getContext());
            state.put("status", status).put("release", release).put("targetVersionCode", release.getLong("versionCode"))
                .put("targetVersionName", release.getString("versionName"));
            if (backupId != null) state.put("backupId", backupId);
            AppUpdateStore.write(getContext(), state);
        }
    }
    private JSObject snapshot() throws Exception {
        JSONObject state = AppUpdateStore.reconcile(getContext());
        state.remove("confirmation"); state.remove("release");
        return new JSObject(state.toString()).put("installed", info());
    }
    private void refreshState(boolean openConfirmation) {
        if (worker.isShutdown()) return;
        worker.execute(() -> {
            try {
                notifyListeners("updateStateChanged", snapshot());
                JSONObject state = AppUpdateStore.read(getContext());
                if (resumed && !cancelled.get() && backupSealed && "permission-required".equals(state.optString("status"))
                    && Build.VERSION.SDK_INT >= 26 && getContext().getPackageManager().canRequestPackageInstalls()) launchInstaller(null);
                if (openConfirmation && resumed) launchConfirmation(false);
            } catch (Exception error) { android.util.Log.e("WuliaoUpdater", "Unable to refresh update", error); }
        });
    }
    @PluginMethod public void getUpdateState(PluginCall call) { execute(call, () -> call.resolve(snapshot())); }
    @Override protected void handleOnResume() { resumed = true; refreshState(false); }
    @Override protected void handleOnPause() { resumed = false; }
    private void terminate(String status, String message) throws Exception {
        synchronized (AppUpdateStore.LOCK) {
            JSONObject state = AppUpdateStore.read(getContext());
            int session = state.optInt("sessionId", -1);
            if (session >= 0 && getContext().getPackageManager().getPackageInstaller().getSessionInfo(session) != null)
                getContext().getPackageManager().getPackageInstaller().abandonSession(session);
            state.put("status", status).put("message", message).put("sessionId", -1);
            state.remove("confirmation");
            AppUpdateStore.write(getContext(), state);
            AppUpdateStore.cleanup(getContext());
            apk = null; backupSealed = false;
        }
    }

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
                if (AppUpdateStore.installing(AppUpdateStore.reconcile(getContext()))) throw new IllegalStateException("请先完成或取消当前更新");
                AppUpdateStore.cleanup(getContext());
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
            boolean started = false;
            try {
                readyRelease(call);
                if (AppUpdateStore.installing(AppUpdateStore.reconcile(getContext()))) throw new IllegalStateException("更新正在等待安装");
                AppUpdateStore.cleanup(getContext());
                backupDir = null; backupId = null;
                synchronized (AppUpdateStore.LOCK) {
                    AppUpdateStore.write(getContext(), new JSONObject().put("status", "downloading").put("attemptId", UUID.randomUUID().toString()).put("sessionId", -1));
                }
                started = true;
                File folder = new File(getContext().getCacheDir(), "updates");
                if (!folder.isDirectory() && !folder.mkdirs()) throw new IllegalStateException("无法创建下载目录");
                long total = release.getLong("apkBytes");
                long backupBytes = UpdateFiles.bytes(new File(getContext().getFilesDir(), "update-backups"));
                if (folder.getUsableSpace() < Math.addExact(Math.multiplyExact(total, 2L), backupBytes) + 32L * 1024 * 1024)
                    throw new IllegalStateException("更新临时空间不足（需要下载、安装暂存及安全备份），请释放空间后重试");
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
                stage("downloaded");
                call.resolve(new JSObject().put("verified", true));
            } catch (Exception error) {
                if (started) terminate("failed", error.getMessage());
                throw error;
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
            terminate("cancelled", "已取消更新，原版本和学习数据保留。");
            call.resolve();
        });
    }
    @PluginMethod public void beginBackup(PluginCall call) {
        execute(call, () -> {
            active(); if (apk == null) throw new IllegalStateException("安装包尚未校验");
            Integer count = call.getInt("accounts");
            if (count == null || count < 1 || count > 10000) throw new IllegalStateException("账号备份数量无效");
            backupId = UUID.randomUUID().toString(); backupAccounts = count; verifiedAccounts.clear(); backupSealed = false; backupHashes = new JSONObject();
            backupDir = new File(getContext().getFilesDir(), "update-backups/" + backupId);
            if (!backupDir.mkdirs()) throw new IllegalStateException("无法创建本机备份");
            stage("backing-up");
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
            if (backupDir.getUsableSpace() < bytes.length + release.getLong("apkBytes") + 32L * 1024 * 1024)
                throw new IllegalStateException("备份和安装暂存空间不足，已停止安装");
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
            backupHashes.put(String.valueOf(call.getInt("accountIndex")), call.getString("sha256"));
            call.resolve(new JSObject().put("verified", true));
        });
    }
    @PluginMethod public void finishBackup(PluginCall call) {
        execute(call, () -> {
            active();
            if (backupId == null || !backupId.equals(call.getString("backupId")) || verifiedAccounts.size() != backupAccounts) throw new IllegalStateException("全账号备份尚未完成");
            JSONObject receipt = new JSONObject().put("targetVersionCode", release.getLong("versionCode")).put("accounts", backupAccounts).put("createdAt", System.currentTimeMillis()).put("sha256", backupHashes);
            try (FileOutputStream output = new FileOutputStream(new File(backupDir, "verified.json"))) {
                output.write(receipt.toString().getBytes(StandardCharsets.UTF_8)); output.getFD().sync();
            }
            backupSealed = true;
            stage("ready");
            AppUpdateStore.prune(getContext(), null);
            call.resolve(new JSObject().put("verified", true));
        });
    }
    @PluginMethod public void installUpdate(PluginCall call) {
        if (!busy.compareAndSet(false, true)) { call.reject("更新正在处理中"); return; }
        execute(call, () -> {
            try {
                active();
                if (!backupSealed || backupDir == null || !AppUpdateStore.verifiedBackup(backupDir)
                    || AppUpdateStore.receipt(backupDir).getLong("targetVersionCode") != release.getLong("versionCode"))
                    throw new IllegalStateException("更新前备份未完成，已停止安装");
                validateApk(apk);
                if (Build.VERSION.SDK_INT >= 26 && !getContext().getPackageManager().canRequestPackageInstalls()) stage("permission-required");
                getActivity().runOnUiThread(() -> {
                    try {
                    if (Build.VERSION.SDK_INT >= 26 && !getContext().getPackageManager().canRequestPackageInstalls()) {
                        Intent intent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getContext().getPackageName()));
                        startActivityForResult(call, intent, "permissionResult");
                    } else execute(call, () -> launchInstaller(call));
                    } catch (Exception error) {
                        execute(call, () -> { terminate("failed", "无法打开系统安装界面"); throw error; });
                    }
                });
            } catch (Exception error) { terminate("failed", error.getMessage()); throw error; }
            finally { busy.set(false); }
        });
    }
    @ActivityCallback private void permissionResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (!cancelled.get() && Build.VERSION.SDK_INT >= 26 && getContext().getPackageManager().canRequestPackageInstalls()) {
            // Repeat the checksum and version checks after returning from Settings.
            installUpdate(call);
        } else execute(call, () -> { terminate("permission-denied", "未允许安装更新，原版本仍保留。"); call.resolve(snapshot()); });
    }
    private void launchInstaller(PluginCall call) throws Exception {
        try {
            active();
            JSONObject current = AppUpdateStore.read(getContext());
            if (current.optInt("sessionId", -1) >= 0) { if (call != null) call.resolve(snapshot()); return; }
            validateApk(apk);
            PackageInstaller installer = getContext().getPackageManager().getPackageInstaller();
            PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
            params.setAppPackageName(getContext().getPackageName()); params.setSize(apk.length());
            if (Build.VERSION.SDK_INT >= 31) params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_REQUIRED);
            if (getContext().getCacheDir().getUsableSpace() < apk.length() + 32L * 1024 * 1024) throw new IllegalStateException("安装暂存空间不足，原版本仍保留。");
            int sessionId = installer.createSession(params);
            try {
                synchronized (AppUpdateStore.LOCK) {
                    current.put("sessionId", sessionId).put("status", "submitted").put("message", "正在准备系统覆盖安装…");
                    AppUpdateStore.write(getContext(), current);
                }
            } catch (Exception error) { installer.abandonSession(sessionId); throw error; }
            try (PackageInstaller.Session session = installer.openSession(sessionId)) {
                try (InputStream input = new FileInputStream(apk); java.io.OutputStream output = session.openWrite("base.apk", 0, apk.length())) {
                    byte[] buffer = new byte[65536]; int count;
                    while ((count = input.read(buffer)) != -1) { active(); output.write(buffer, 0, count); }
                    session.fsync(output);
                }
                active();
                Intent result = new Intent(getContext(), AppUpdateReceiver.class).setAction(AppUpdateStore.resultAction(getContext()))
                    .putExtra("attemptId", current.getString("attemptId"));
                int flags = PendingIntent.FLAG_UPDATE_CURRENT;
                if (Build.VERSION.SDK_INT >= 31) flags |= PendingIntent.FLAG_MUTABLE;
                PendingIntent callback = PendingIntent.getBroadcast(getContext(), sessionId, result, flags);
                session.commit(callback.getIntentSender());
            }
            if (call != null) call.resolve(snapshot());
            else notifyListeners("updateStateChanged", snapshot());
        } catch (Exception error) { terminate("failed", error.getMessage()); throw error; }
    }
    private void launchConfirmation(boolean force) throws Exception {
        final Intent confirmation;
        synchronized (AppUpdateStore.LOCK) {
            JSONObject state = AppUpdateStore.read(getContext());
            if (!"pending-user-action".equals(state.optString("status")) || !state.has("confirmation") || (!force && state.optBoolean("promptLaunched"))) return;
            confirmation = AppUpdateStore.decodeIntent(state.getString("confirmation"));
            state.put("promptLaunched", true); AppUpdateStore.write(getContext(), state);
        }
        getActivity().runOnUiThread(() -> {
            try { getActivity().startActivity(confirmation); }
            catch (Exception error) {
                if (!worker.isShutdown()) worker.execute(() -> {
                    try { terminate("failed", "无法打开系统安装确认，请重试"); notifyListeners("updateStateChanged", snapshot()); }
                    catch (Exception failure) { android.util.Log.e("WuliaoUpdater", "Unable to finish failed confirmation", failure); }
                });
            }
        });
    }
    @PluginMethod public void resumeUpdate(PluginCall call) {
        execute(call, () -> {
            JSONObject state = AppUpdateStore.reconcile(getContext());
            if ("ready".equals(state.optString("status")) || "permission-required".equals(state.optString("status"))) { installUpdate(call); return; }
            if ("pending-user-action".equals(state.optString("status"))) launchConfirmation(true);
            call.resolve(snapshot());
        });
    }
    @Override protected void handleOnDestroy() {
        resumed = false;
        cancelled.set(true);
        if (connection != null) connection.disconnect();
        if (stateReceiver != null) getContext().unregisterReceiver(stateReceiver);
        // Submitted sessions and complete backups survive Activity destruction.
        worker.shutdown();
    }
}
