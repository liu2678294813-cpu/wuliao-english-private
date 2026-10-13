import test from "node:test";
import assert from "node:assert/strict";
import { createUpdateController } from "../src/appUpdater.js";

const release = { available: true, releaseId: 1, versionName: "1.0.87", versionCode: 93, apkBytes: 100, installed: { versionName: "1.0.85", versionCode: 91 } };
function fixture(overrides = {}, backupError = null) {
  const calls = [], changes = [];
  const plugin = {
    checkLatest: async () => { calls.push("check"); return release; },
    addListener: async () => ({ remove: async () => {} }),
    downloadUpdate: async () => { calls.push("download"); return { verified: true }; },
    cancelDownload: async () => { calls.push("cancel-download"); },
    installUpdate: async () => { calls.push("install"); return { status: "cancelled" }; },
    ...overrides,
  };
  const controller = createUpdateController({ plugin, onChange: (value) => changes.push(value), backup: async () => {
    calls.push("backup"); if (backupError) throw backupError;
  } });
  return { controller, calls, changes };
}
test("cancel after check performs zero downloads, backups or installations", async () => {
  const { controller, calls } = fixture();
  await controller.check(); await controller.cancel();
  assert.deepEqual(calls, ["check"]); assert.equal(controller.state.phase, "idle");
});
test("confirmed update installs only after verified download and successful backup", async () => {
  const { controller, calls } = fixture(); await controller.check(); await controller.update();
  assert.deepEqual(calls, ["check", "download", "backup", "install"]);
  assert.match(controller.state.message, /原版本仍保留/);
});
test("cancel during download invalidates late completion and prevents backup", async () => {
  let finish;
  const { controller, calls } = fixture({ downloadUpdate: () => new Promise((resolve) => { finish = resolve; calls.push("download"); }) });
  await controller.check(); const updating = controller.update();
  await new Promise((resolve) => setImmediate(resolve)); await controller.cancel(); finish({ verified: true }); await updating;
  assert.deepEqual(calls, ["check", "download", "cancel-download"]); assert.equal(controller.state.phase, "idle");
});
test("duplicate update clicks start one download and one installation", async () => {
  const { controller, calls } = fixture(); await controller.check();
  await Promise.all([controller.update(), controller.update()]); assert.equal(calls.filter((x) => x === "download").length, 1);
});
test("failed backup blocks installation", async () => {
  const { controller, calls } = fixture({}, Error("数据库读取失败")); await controller.check(); await controller.update();
  assert.deepEqual(calls, ["check", "download", "backup"]); assert.equal(controller.state.phase, "error");
});
test("unverified download and interrupted network block backup and installation", async () => {
  for (const downloadUpdate of [async () => ({ verified: false }), async () => { throw Error("网络中断"); }]) {
    const { controller, calls } = fixture({ downloadUpdate }); await controller.check(); await controller.update();
    assert.deepEqual(calls, ["check"]); assert.equal(controller.state.phase, "error");
  }
});
test("check failure is never reported as current latest, and is retryable", async () => {
  let n = 0;
  const { controller } = fixture({ checkLatest: async () => { if (++n === 1) throw Error("GitHub 限流"); return { available: false, installed: release.installed }; } });
  await controller.check(); assert.equal(controller.state.phase, "error"); assert.match(controller.state.message, /限流/);
  await controller.check(); assert.equal(controller.state.phase, "latest");
});
test("same or lower remote code cannot trigger download", async () => {
  const { controller, calls } = fixture({ checkLatest: async () => ({ available: false, installed: release.installed }) });
  await controller.check(); await controller.update(); assert.deepEqual(calls, []); assert.equal(controller.state.phase, "latest");
});
test("denied install permission reports retained old version", async () => {
  const { controller } = fixture({ installUpdate: async () => ({ status: "permission-denied" }) });
  await controller.check(); await controller.update(); assert.match(controller.state.message, /未允许安装/);
});
