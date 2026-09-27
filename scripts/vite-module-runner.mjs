import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const viteRequire = createRequire(require.resolve("vite"));
const { build } = viteRequire("esbuild");
const TEMP_PREFIX = "wuliao-vite-test-";

function testBundlePlugins() {
  return [{
    name: "test-bundle-runtime",
    setup(bundle) {
      bundle.onResolve({ filter: /\?url$/ }, (args) => ({ path: args.path, namespace: "url-stub" }));
      bundle.onLoad({ filter: /.*/, namespace: "url-stub" }, () => ({ contents: "export default '';", loader: "js" }));
      bundle.onResolve({ filter: /\.(?:css|scss|sass|less)$/ }, (args) => ({ path: args.path, namespace: "style-stub" }));
      bundle.onLoad({ filter: /.*/, namespace: "style-stub" }, () => ({ contents: "export default {};", loader: "js" }));
      bundle.onResolve({ filter: /^(?:node:|[^./]|@)/ }, (args) => {
        if (args.path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(args.path)) return null;
        if (args.path.startsWith("node:")) return { path: args.path, external: true };
        try {
          return { path: pathToFileURL(require.resolve(args.path)).href, external: true };
        } catch {
          return null;
        }
      });
    },
  }];
}

// Vite 8's middleware ModuleRunner can spend minutes preloading the complete
// application graph before these jsdom tests start. Bundle only the requested
// source entry instead; package imports remain external so React is shared with
// the test process and hooks keep a single runtime instance.
export async function createViteModuleRunner(root) {
  const tempRoot = await mkdtemp(join(tmpdir(), TEMP_PREFIX));
  const bundles = new Map();
  let bundleIndex = 0;
  let closePromise;

  const close = () => {
    closePromise ||= (async () => {
      const resolvedTempRoot = resolve(tempRoot);
      if (dirname(resolvedTempRoot) !== resolve(tmpdir()) || !basename(resolvedTempRoot).startsWith(TEMP_PREFIX)) {
        throw new Error(`Refusing to remove unexpected test bundle directory: ${resolvedTempRoot}`);
      }
      await rm(resolvedTempRoot, { recursive: true, force: true });
    })();
    return closePromise;
  };

  return {
    async import(moduleId) {
      try {
        if (bundles.has(moduleId)) return bundles.get(moduleId);
        bundleIndex += 1;
        const outputPath = join(tempRoot, `entry-${bundleIndex}.mjs`);
        const sourcePath = moduleId.startsWith("/") ? resolve(root, moduleId.slice(1)) : resolve(root, moduleId);
        await build({
          entryPoints: [sourcePath],
          outfile: outputPath,
          bundle: true,
          format: "esm",
          platform: "node",
          target: "node24",
          jsx: "automatic",
          logLevel: "silent",
          define: { "import.meta.env.BASE_URL": '"/"' },
          plugins: testBundlePlugins(),
        });
        const loaded = await import(`${pathToFileURL(outputPath).href}?bundle=${bundleIndex}`);
        bundles.set(moduleId, loaded);
        return loaded;
      } catch (error) {
        await close();
        throw error;
      }
    },
    close,
  };
}
