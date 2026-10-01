// プラグイン本体 (sdPlugin/bin/plugin.js) と CLI (dist/herdr-deck.mjs) を esbuild でまとめ、アイコンを作る。
//   node scripts/build.mjs          1回ビルド
//   node scripts/build.mjs --watch  変更を監視して再ビルド (Stream Deck 上のプラグインも再起動する)
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sdPlugin = join(root, "com.kuruusuniku.herdr-deck.sdPlugin");
const watch = process.argv.includes("--watch");

// SDK が依存する ws は CommonJS で require を使うので、ESM バンドル内でも require を使えるようにする
const banner = {
  js: "import { createRequire as __herdrDeckCreateRequire } from 'node:module'; const require = __herdrDeckCreateRequire(import.meta.url);",
};

const common = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: "linked",
  banner,
  // ws の任意依存 (ネイティブ拡張)。無ければ ws が自動で JS 実装を使う
  external: ["bufferutil", "utf-8-validate"],
  logLevel: "info",
};

const restartPlugin = {
  name: "restart-stream-deck-plugin",
  setup(build) {
    build.onEnd((result) => {
      if (!watch || result.errors.length) return;
      try {
        execFileSync(join(root, "node_modules", ".bin", "streamdeck"), ["restart", "com.kuruusuniku.herdr-deck"], { stdio: "inherit" });
      } catch {
        // Stream Deck が無い環境 (CI など) では無視
      }
    });
  },
};

const pluginOptions = {
  ...common,
  entryPoints: [join(root, "src", "plugin.ts")],
  outfile: join(sdPlugin, "bin", "plugin.js"),
  plugins: [restartPlugin],
};
const cliOptions = {
  ...common,
  entryPoints: [join(root, "src", "cli.ts")],
  outfile: join(root, "dist", "herdr-deck.mjs"),
  banner: { js: `#!/usr/bin/env node\n${banner.js}` },
};

// bin/plugin.js を ES Module として読ませるため
mkdirSync(join(sdPlugin, "bin"), { recursive: true });
writeFileSync(join(sdPlugin, "bin", "package.json"), '{ "type": "module" }\n');

if (watch) {
  const contexts = await Promise.all([esbuild.context(pluginOptions), esbuild.context(cliOptions)]);
  await Promise.all(contexts.map((c) => c.watch()));
} else {
  await Promise.all([esbuild.build(pluginOptions), esbuild.build(cliOptions)]);
  execFileSync(process.execPath, [join(root, "dist", "herdr-deck.mjs"), "icons", sdPlugin], { stdio: "inherit" });
}
