package com.wuliao.english;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;
import android.util.Log;
import org.json.JSONObject;

/** Explicit PendingIntent receiver survives replacement of the app process. */
public final class AppUpdateReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context context, Intent intent) {
        if (!AppUpdateStore.resultAction(context).equals(intent.getAction())) return;
        PendingResult pending = goAsync();
        new Thread(() -> {
            try {
                synchronized (AppUpdateStore.LOCK) {
                    JSONObject state = AppUpdateStore.read(context);
                    if (!state.optString("attemptId").equals(intent.getStringExtra("attemptId"))
                        || state.optInt("sessionId", -1) != intent.getIntExtra(PackageInstaller.EXTRA_SESSION_ID, -2)
                        || !AppUpdateStore.installing(state)) return;
                    int status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
                    if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
                        Intent confirmation = intent.getParcelableExtra(Intent.EXTRA_INTENT);
                        if (confirmation == null) throw new IllegalStateException("系统未提供安装确认界面");
                        state.put("status", "pending-user-action").put("confirmation", AppUpdateStore.encodeIntent(confirmation))
                            .put("promptLaunched", false).put("message", "请确认覆盖更新，学习数据将保留。");
                    } else {
                        boolean installed = state.optLong("targetVersionCode") > 0
                            && AppUpdateStore.installedCode(context) >= state.getLong("targetVersionCode");
                        state.put("status", installed ? "installed" : status == PackageInstaller.STATUS_FAILURE_ABORTED ? "cancelled" : "failed")
                            .put("errorCode", status).put("message", installed ? "更新已完成" : status == PackageInstaller.STATUS_FAILURE_ABORTED
                                ? "已取消安装，原版本仍保留。" : status == PackageInstaller.STATUS_FAILURE_STORAGE
                                ? "安装空间不足，原版本仍保留。" : "系统未完成更新：" + intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE));
                        state.remove("confirmation");
                    }
                    AppUpdateStore.write(context, state);
                    if (!AppUpdateStore.installing(state)) AppUpdateStore.cleanup(context);
                }
            } catch (Exception error) {
                Log.e("WuliaoUpdater", "Installation result handling failed", error);
                try {
                    synchronized (AppUpdateStore.LOCK) {
                        JSONObject state = AppUpdateStore.read(context);
                        state.put("status", "failed").put("message", "更新结果处理失败，请重新检查更新");
                        AppUpdateStore.write(context, state);
                    }
                } catch (Exception ignored) { /* Keep recovery material when IO fails. */ }
            } finally {
                context.sendBroadcast(new Intent(AppUpdateStore.changeAction(context)).setPackage(context.getPackageName()));
                pending.finish();
            }
        }, "wuliao-install-result").start();
    }
}
