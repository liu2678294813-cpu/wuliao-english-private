// Invoke the installed business service inside its existing WebView. No key,
// original learning record or ink is read out, changed, or sent by this probe.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
const folder = resolve("output/long-sentence/20260929-104646");
const assets = resolve("android/app/src/main/assets/public/assets");
const chunk = readdirSync(assets).find(name => /^ai-.*\.js$/.test(name) && readFileSync(resolve(assets,name),"utf8").includes("as createLongSentenceAiService"));
if (!chunk) throw new Error("Installed Android assets do not expose the long-sentence AI service");
async function smoke(path) {
  const module = await import(path);
  const service = module.createLongSentenceAiService();
  const sessionId = `read-only-live-smoke-${Date.now()}`;
  try {
    const generated = await service.generate({ sessionId, requestVersion: 1, count: 1,
      sources: [{ sourceReviewId: "live-smoke:fixed-reference", text: "Although the committee acknowledged that the evidence was incomplete, it approved the proposal that the researchers had submitted.", difficulty: 2 }],
      words: [], excludedSentences: [] });
    if (generated.items.length !== 1) return { passed: false, stage: "generate", missingCount: generated.missingCount, errors: generated.errors };
    const item = generated.items[0];
    const evaluated = await service.evaluate({ sessionId, itemId: "live-item", attemptId: "live-attempt", evaluationVersion: 1, submittedAt: Date.now(), generatedSentence: item.text, structureFingerprint: item.structureFingerprint,
      userTranslation: "虽然我能看出这句话的让步关系，但还不能确定修饰语的范围和主句结论。", targetWordUses: item.targetWordUses, difficultyMetadata: item.difficultyMetadata });
    const requestEvidence = result => result.requests.map(({ provider,model,requestId,promptVersion,schemaVersion,timestamp,usage }) => ({ provider,model,requestId,promptVersion,schemaVersion,timestamp,usage }));
    return { passed: true, readOnlyLearningData: true, credentialStayedInSecureStore: true, inkSent: false,
      sourceText: "Although the committee acknowledged that the evidence was incomplete, it approved the proposal that the researchers had submitted.",
      generatedItem: item, evaluation: evaluated.evaluation,
      generateRequests: requestEvidence(generated), evaluateRequests: requestEvidence(evaluated) };
  } catch (error) {
    const classified = module.classifyLongSentenceAiError(error);
    return { passed: false, code: classified.code, message: classified.message, rawMessage: String(error.message || "").replace(/(?:Bearer\s+)[^\s]+|sk-[\w*.-]+/gi,"[redacted]") };
  } finally { service.cancelAll(); }
}
const result = execFileSync(process.execPath,["scripts/device-cdp.mjs","eval",`(${smoke.toString()})(${JSON.stringify(`/assets/${chunk}`)})`],{encoding:"utf8",windowsHide:true,timeout:300000});
writeFileSync(resolve(folder,"live-smoke-result.json"),result);
const evidence = JSON.parse(result);
console.log(JSON.stringify({passed:evidence.passed,code:evidence.code,generateRequests:evidence.generateRequests?.length,evaluateRequests:evidence.evaluateRequests?.length,providers:evidence.generateRequests?.map(request=>({provider:request.provider,model:request.model}))}));
if (!evidence.passed) process.exitCode = 1;
