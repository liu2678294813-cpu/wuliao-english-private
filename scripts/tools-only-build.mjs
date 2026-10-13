import { rmSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";

// Keep the existing repositories and learning tools; only replace packaged catalogs.
export function toolsOnlyBuild() {
  const replacements = new Map([
    ["/writing/questions/generatedWritingQuestionData.js", "export const GENERATED_WRITING_QUESTIONS = Object.freeze([]);"],
    ["/writing/generatedWritingSampleCatalog.js", "export const BUNDLED_WRITING_SAMPLE_CATALOG = Object.freeze({ catalogSchemaVersion: 1, catalogVersion: 'tools-only', activeQuestionIds: [], retiredSamples: [], items: [] });"],
  ]);
  let outputDir;
  return {
    name: "tools-only-content",
    apply: "build",
    enforce: "pre",
    configResolved(config) {
      outputDir = resolve(config.root, config.build.outDir);
      const path = relative(config.root, outputDir);
      if (!path || path.startsWith("..") || isAbsolute(path)) throw new Error("Tools-only output must be inside the project.");
    },
    resolveId(source) {
      const normalized = source.replaceAll("\\", "/");
      for (const [suffix] of replacements) {
        if (normalized.endsWith(suffix) || normalized === `.${suffix.slice(suffix.lastIndexOf("/"))}` || normalized === "./questions/generatedWritingQuestionData.js" && suffix.includes("/questions/")) {
          return `\0tools-only:${suffix}`;
        }
      }
    },
    load(id) {
      if (id.startsWith("\0tools-only:")) return replacements.get(id.slice("\0tools-only:".length));
    },
    writeBundle() {
      // Vite copies public files even when nothing imports them. Remove their bytes too.
      for (const directory of ["library", "writing"]) rmSync(resolve(outputDir, directory), { recursive: true, force: true });
    },
  };
}
