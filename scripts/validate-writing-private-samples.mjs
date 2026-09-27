import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createWritingPrivateSamplesService } from "../src/writing/writingPrivateSamples.js";

const inputArgument = process.argv[2];
if (!inputArgument) {
  console.error("Usage: node --import ./scripts/test-hooks.mjs scripts/validate-writing-private-samples.mjs <payload.json>");
  process.exit(2);
}

const inputPath = path.resolve(inputArgument);
const payload = JSON.parse(fs.readFileSync(inputPath, "utf8"));
const records = new Map();
const username = "__private_payload_validator__";
const catalog = { catalogSchemaVersion: 1, catalogVersion: "validator", contentHash: "", activeQuestionIds: [], retiredQuestionIds: [], retiredSamples: [], items: [] };
const service = createWritingPrivateSamplesService({
  username,
  catalog,
  getCurrentUsername: () => username,
  now: () => 0,
  putRecords: async (items) => {
    for (const item of items) records.set(item.questionId, structuredClone(item));
  },
  getRecord: async (_username, questionId) => structuredClone(records.get(questionId) || null),
  listRecords: async () => [...records.values()].map((record) => structuredClone(record)),
});

const imported = await service.importPayload(payload);
const available = await service.listAvailableQuestionIds();
if (available.length !== imported.importedCount) throw new Error("Some imported records failed stored-record validation.");

const years = [];
for (const item of payload.items) {
  const snapshot = await service.getSampleSnapshot(item.questionId);
  if (
    snapshot.sourceType !== "device_private"
    || snapshot.distributionScope !== "device_private"
    || snapshot.generatorMetadata !== null
    || snapshot.segments.length !== 1
    || snapshot.segments[0].text !== item.referenceEssay
  ) {
    throw new Error(`Private runtime contract failed for ${item.questionId}.`);
  }
  years.push(item.year);
}

console.log(JSON.stringify({
  status: "valid",
  importedCount: imported.importedCount,
  yearRange: years.length ? [Math.min(...years), Math.max(...years)] : [],
  payloadBytes: fs.statSync(inputPath).size,
}));
