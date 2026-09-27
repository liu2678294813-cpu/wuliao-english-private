import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (...parts) => readFileSync(join(root, ...parts), "utf8");
const manifest = read("android", "app", "src", "main", "AndroidManifest.xml");
const java = read("android", "app", "src", "main", "java", "com", "wuliao", "english", "MainActivity.java");
const legacyRules = read("android", "app", "src", "main", "res", "xml", "backup_rules.xml");
const modernRules = read("android", "app", "src", "main", "res", "xml", "data_extraction_rules.xml");
const userData = read("src", "userData.js");
const ai = read("src", "ai.js");
const vision = read("src", "writing", "writingVisionConfig.js");
const app = read("src", "App.jsx");
const backup = read("src", "backup.js");

const preferenceName = java.match(/PREF_NAME\s*=\s*"([^"]+)"/)?.[1];
const preferenceFile = `${preferenceName}.xml`;

function exclusions(xml) {
  return [...xml.matchAll(/<exclude\s+domain="([^"]+)"\s+path="([^"]+)"\s*\/\s*>/g)]
    .map((match) => ({ domain: match[1], path: match[2] }));
}

test("Manifest disables OS backup so WebView private stores cannot be copied as one database file", () => {
  assert.match(manifest, /android:allowBackup="false"/);
  assert.match(manifest, /android:fullBackupContent="@xml\/backup_rules"/);
  assert.match(manifest, /android:dataExtractionRules="@xml\/data_extraction_rules"/);
});

test("private Writing seed crosses only the app no-backup directory and is deleted after import", () => {
  assert.match(java, /getNoBackupFilesDir\(\)/);
  assert.match(java, /writing-private-samples-seed\.json/);
  assert.match(java, /AndroidPrivateWritingSamples/);
  assert.match(java, /clearPendingSeed/);
});

test("backup exclusions are coupled to the real AndroidSecureStore SharedPreferences filename", () => {
  assert.equal(preferenceName, "wuliao_secure_store");
  assert.deepEqual(exclusions(legacyRules), [{ domain: "sharedpref", path: preferenceFile }]);
  assert.deepEqual(exclusions(modernRules), [
    { domain: "sharedpref", path: preferenceFile },
    { domain: "sharedpref", path: preferenceFile },
  ]);
});

test("Android 12+ excludes credentials from both cloud backup and device transfer", () => {
  const cloud = modernRules.match(/<cloud-backup[^>]*>([\s\S]*?)<\/cloud-backup>/)?.[1] || "";
  const transfer = modernRules.match(/<device-transfer[^>]*>([\s\S]*?)<\/device-transfer>/)?.[1] || "";
  assert.deepEqual(exclusions(cloud), [{ domain: "sharedpref", path: preferenceFile }]);
  assert.deepEqual(exclusions(transfer), [{ domain: "sharedpref", path: preferenceFile }]);
});

test("rules do not globally exclude SharedPreferences, databases, files, or WebView learning data", () => {
  for (const rule of [...exclusions(legacyRules), ...exclusions(modernRules)]) {
    assert.equal(rule.domain, "sharedpref");
    assert.equal(rule.path, preferenceFile);
    assert.notEqual(rule.path, ".");
  }
  assert.doesNotMatch(`${legacyRules}\n${modernRules}`, /<include\b/);
  assert.doesNotMatch(`${legacyRules}\n${modernRules}`, /domain="(?:root|file|database|external|device_root|device_file|device_database)"/);
});

test("Text, Vision, and password verifier material converge on the excluded native store", () => {
  assert.match(ai, /ai:apikey:/);
  assert.match(vision, /ai:vision-apikey:/);
  assert.match(userData, /account:password-verifier:v1:/);
  assert.match(userData, /writeAndroidPasswordVerifier/);
  assert.match(userData, /putAccountRecord\(accountWithoutPasswordVerifier\(next\)\)/);
  assert.match(userData, /if \(legacyVerifier\) await putAccountRecord\(profile\)/);
  assert.match(app, /getAiApiKey\(\)/);
  assert.match(app, /getWritingVisionApiKey\(\{ username: nextUsername \}\)/);
});

test("native secret writes are verified before plaintext web fallbacks are removed", () => {
  assert.match(ai, /await secureStore\.get\?\.\(key\)/);
  assert.match(ai, /removeUserItem\("wuliao:ai:apikey"\)/);
  assert.match(vision, /await secureStore\.get\?\.\(storageKey\)/);
  assert.match(vision, /removeUserItem\(WRITING_VISION_SECRET_KEY, username\)/);
  assert.match(userData, /confirmed !== serialized/);
});

test("application Backup v1 remains unchanged and includes Writing ink while excluding credentials", () => {
  assert.match(backup, /BACKUP_FORMAT = "wuliao-backup"/);
  assert.match(backup, /BACKUP_VERSION = 1/);
  assert.match(backup, /"writing-ink": \{ mergeByFingerprint: true \}/);
  assert.match(backup, /"device-private-writing-samples"/);
  assert.match(backup, /KaoyanVocabDB: \["users"\]/);
  assert.match(backup, /SECRET_KEY_PATTERN/);
});
