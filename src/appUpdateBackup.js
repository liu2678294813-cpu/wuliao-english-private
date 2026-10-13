import { createBackup, readUpdateBackupSources } from "./backup.js";
import { hashUpdateAttachment, writeStreamedUpdateBackup } from "./updateBackupStream.js";
import { flushPendingSaves } from "./saveCoordinator.js";
import { flushDurableInk } from "./durableInkStorage.js";

export async function persistUpdateBackups(plugin, active, appVersion) {
  await flushPendingSaves();
  active();
  // Current surfaces register their writes with the save coordinator. Flush all
  // hydrated accounts too; remaining accounts are read directly from durable IDB.
  let sources = await readUpdateBackupSources();
  for (const username of sources.usernames) { await flushDurableInk(username); active(); }
  sources = null; // Release the first large ink snapshot before reading again.
  sources = await readUpdateBackupSources();
  active();
  const { backupId } = await plugin.beginBackup({ accounts: sources.usernames.length });
  for (let accountIndex = 0; accountIndex < sources.usernames.length; accountIndex++) {
    active();
    const blobs = new Map();
    const { manifest } = await createBackup({ sources, username: sources.usernames[accountIndex], appVersion, serialize: false,
      encodeAttachment: async blob => {
        const id = `att-${blobs.size + 1}`; blobs.set(id, blob);
        return hashUpdateAttachment(blob, active);
      },
    });
    await writeStreamedUpdateBackup({ manifest, blobs, plugin, backupId, accountIndex, active });
  }
  active();
  const result = await plugin.finishBackup({ backupId });
  if (!result?.verified) throw new Error("全账号备份未完成，已停止安装");
}
