import { browserEncodeAttachment, createBackup, parseBackup, readUpdateBackupSources } from "./backup.js";
import { flushPendingSaves } from "./saveCoordinator.js";
import { flushDurableInk } from "./durableInkStorage.js";

function base64(bytes) {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 8192) binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
  return btoa(binary);
}

export async function persistUpdateBackups(plugin, active, appVersion) {
  await flushPendingSaves();
  active();
  // Current surfaces register their writes with the save coordinator. Flush all
  // hydrated accounts too; remaining accounts are read directly from durable IDB.
  let sources = await readUpdateBackupSources();
  for (const username of sources.usernames) { await flushDurableInk(username); active(); }
  sources = await readUpdateBackupSources();
  active();
  const { backupId } = await plugin.beginBackup({ accounts: sources.usernames.length });
  for (let accountIndex = 0; accountIndex < sources.usernames.length; accountIndex++) {
    active();
    const { fileText } = await createBackup({ sources, username: sources.usernames[accountIndex], appVersion, encodeAttachment: browserEncodeAttachment });
    await parseBackup(fileText);
    const bytes = new TextEncoder().encode(fileText);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    const sha256 = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    for (let offset = 0; offset < bytes.length; offset += 192 * 1024) {
      active();
      await plugin.writeBackupChunk({ backupId, accountIndex, offset, data: base64(bytes.subarray(offset, offset + 192 * 1024)) });
    }
    active();
    const result = await plugin.finishBackupAccount({ backupId, accountIndex, sha256 });
    if (!result?.verified) throw new Error("本机备份未通过校验，已停止安装");
  }
  active();
  const result = await plugin.finishBackup({ backupId });
  if (!result?.verified) throw new Error("全账号备份未完成，已停止安装");
}
