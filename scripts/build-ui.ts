/**
 * Builds the MCP Apps pieces that run in a browser (SPEC "MCP Apps view") into .generated/ui/:
 *
 *   transfer.html  the ui://nuvio-remit/transfer view: one self-contained HTML document, script
 *                  and styles inline, as MCP Apps hosts expect (no network requests).
 *   app-host.js    the simulator's host side (the SDK's AppBridge plus our glue), an ES module
 *                  the simulator page imports.
 *
 * Both bundle @modelcontextprotocol/ext-apps with its dependencies, using tsup (already the
 * server's bundler) so there is no extra build tool. `pnpm dev`, `pnpm build` and the test setup
 * run this first; tsup copies the output into dist/ui for the production image.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build, type Options } from "tsup";

const root = fileURLToPath(new URL("../", import.meta.url));
export const UI_OUT = `${root}.generated/ui/`;

type Plugin = NonNullable<Options["esbuildPlugins"]>[number];

/**
 * Zod v4 re-exports all of its ~50 locales from its namespace (`z.locales`), so a bundler keeps
 * every one: 260 KB of the view's 525 KB. Nothing here picks a locale (English is the default),
 * so `locales/index.js` is swapped for one that exports only `en`. See FRICTION_LOG.md.
 */
const zodEnglishOnly: Plugin = {
  name: "zod-english-only",
  setup(b) {
    b.onResolve({ filter: /^\.\.\/locales\/index\.js$/ }, (args) =>
      /[\\/]zod[\\/]v4[\\/]/.test(args.importer)
        ? { path: resolve(dirname(args.importer), args.path), namespace: "zod-locales" }
        : undefined,
    );
    b.onLoad({ filter: /.*/, namespace: "zod-locales" }, (args) => ({
      contents: `export { default as en } from ${JSON.stringify(join(dirname(args.path), "en.js"))};`,
      loader: "js",
      resolveDir: dirname(args.path),
    }));
  },
};

const common: Options = {
  esbuildPlugins: [zodEnglishOnly],
  config: false,
  tsconfig: `${root}src/ui/tsconfig.json`,
  platform: "browser",
  target: "es2022",
  bundle: true,
  noExternal: [/.*/],
  minify: true,
  sourcemap: false,
  dts: false,
  splitting: false,
  clean: false,
  silent: true,
  env: { NODE_ENV: "production" },
  outExtension: () => ({ js: ".js" }),
};

/** Inline script text must not close its own <script> element. */
const scriptSafe = (js: string) => js.replace(/<\/(script)/gi, "<\\/$1");

export async function buildUi(): Promise<{ view: number; host: number }> {
  const tmp = `${UI_OUT}tmp/`;
  rmSync(UI_OUT, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });

  await build({
    ...common,
    entry: { transfer: `${root}src/ui/transfer/main.ts` },
    format: ["iife"],
    outDir: tmp,
  });
  await build({
    ...common,
    entry: { "app-host": `${root}src/ui/host/app-host.ts` },
    format: ["esm"],
    outDir: UI_OUT,
  });

  const js = readFileSync(`${tmp}transfer.js`, "utf8");
  const css = readFileSync(`${root}src/ui/transfer/view.css`, "utf8");
  const html = readFileSync(`${root}src/ui/transfer/index.html`, "utf8")
    .replace("/*{{style}}*/", () => css)
    .replace("/*{{script}}*/", () => scriptSafe(js));
  writeFileSync(`${UI_OUT}transfer.html`, html);
  rmSync(tmp, { recursive: true, force: true });

  return {
    view: Buffer.byteLength(html),
    host: Buffer.byteLength(readFileSync(`${UI_OUT}app-host.js`)),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const sizes = await buildUi();
  const kb = (n: number) => `${Math.round(n / 1024)} KB`;
  console.log(
    `ui: transfer.html ${kb(sizes.view)}, app-host.js ${kb(sizes.host)} -> .generated/ui/`,
  );
}
