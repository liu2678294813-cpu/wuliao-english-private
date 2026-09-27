import assert from "node:assert/strict";
import { readFile, readdir, lstat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(process.argv[2] || fileURLToPath(new URL("../public/vocabulary/pronunciation/", import.meta.url)));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const read = async (name) => JSON.parse(await readFile(path.join(root, name), "utf8"));
const [manifest, variants, index, report] = await Promise.all(["manifest.json", "variants.json", "index.json", "validation.json"].map(read));
assert.deepEqual(report.issues, [], "Audio signal validation must pass before packaging");
assert.equal(Object.keys(manifest.entries).length, manifest.uniqueWords, "Incomplete vocabulary coverage");
assert.equal(report.coveredWords, manifest.uniqueWords);
assert.equal(report.manifestSha256, hash(await readFile(path.join(root, "manifest.json"))), "Stale validation manifest");
assert.equal(report.variantsSha256, hash(await readFile(path.join(root, "variants.json"))), "Stale variant validation");
assert.deepEqual(Object.keys(index.entries).sort(), Object.keys(manifest.entries).sort(), "Playback catalog differs from verified vocabulary");
assert.deepEqual(Object.keys(index.variants).sort(), Object.keys(variants).sort());
const compareIndex = (entry, indexed) => {
  assert.equal(indexed?.path, entry.path, `Wrong playback path for ${entry.word}`);
  assert.equal(indexed?.revision, entry.sha256.slice(0, 16), `Stale audio revision for ${entry.word}`);
};
for (const [word, entry] of Object.entries(manifest.entries)) compareIndex(entry, index.entries[word]);
for (const [word, choices] of Object.entries(variants)) {
  assert.deepEqual(Object.keys(index.variants[word]).sort(), Object.keys(choices).sort());
  for (const [pos, entry] of Object.entries(choices)) compareIndex(entry, index.variants[word][pos]);
}
const records = [...Object.values(manifest.entries), ...Object.values(variants).flatMap(Object.values), ...Object.values(manifest.basePronunciations || {})];
const files = new Map();
for (const entry of records) {
  assert.match(entry.path, /^audio\/[a-f0-9]+\.ogg$/);
  assert.match(entry.sha256, /^[a-f0-9]{64}$/);
  assert.equal(entry.pipelineVersion, 2);
  assert.equal(entry.trim, false);
  assert.equal(entry.retainedRawSampleCount, entry.rawSampleCount);
  assert.equal(entry.outputSampleCount, entry.rawSampleCount + entry.paddingSamples.leading + entry.paddingSamples.trailing);
  if (files.has(entry.path)) assert.equal(files.get(entry.path).sha256, entry.sha256, "Conflicting records for one audio file");
  files.set(entry.path, entry);
}
assert.equal(report.verifiedFiles, files.size);
assert.equal(report.fullWaveformSampleCountsVerified, files.size);
assert.equal(report.rawCheckpointsVerified, files.size);
assert.deepEqual((await readdir(path.join(root, "audio"))).sort(), [...files.keys()].map((file) => file.slice(6)).sort(), "Missing or unverified deployed audio");
for (const [relative, entry] of files) {
  const file = path.join(root, relative);
  assert.ok((await lstat(file)).isFile(), "Audio must be a regular file");
  assert.equal(hash(await readFile(file)), entry.sha256, `Audio changed after validation: ${relative}`);
}
console.log(JSON.stringify({ coveredWords: Object.keys(manifest.entries).length, uniqueAudioFiles: files.size, variants: Object.values(variants).reduce((n, choices) => n + Object.keys(choices).length, 0), manifestSha256: report.manifestSha256, status: "passed" }));
