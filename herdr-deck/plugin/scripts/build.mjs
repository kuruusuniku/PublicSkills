// ビルド:
//   - Stream Deck 用: com.kuruusuniku.herdr-deck.sdPlugin/bin/plugin.js (公式 SDK, ESM, Node 24)
//   - VSD Craft 用:   vsd/com.kuruusuniku.herdr-deck.sdPlugin/bin/plugin.js (SDK なし, CommonJS, Node 20)
//   - CLI:            dist/herdr-deck.mjs
//   - 両プラグインのアイコン PNG と設定画面 (ui/)
//
//   node scripts/build.mjs          1回ビルド
//   node scripts/build.mjs --watch  変更を監視して再ビルド (Stream Deck 上のプラグインも再起動する)
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const elgatoDir = join(root, "com.kuruusuniku.herdr-deck.sdPlugin");
const vsdDir = join(root, "vsd", "com.kuruusuniku.herdr-deck.sdPlugin");
const watch = process.argv.includes("--watch");

// SDK が依存する ws は CommonJS で require を使うので、ESM バンドル内でも require を使えるようにする
const esmRequire = "import { createRequire as __herdrDeckCreateRequire } from 'node:module'; const require = __herdrDeckCreateRequire(import.meta.url);";

const common = {
  bundle: true,
  platform: "node",
  sourcemap: "linked",
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
        // Stream Deck が無い環境では無視
      }
    });
  },
};

const elgatoOptions = {
  ...common,
  format: "esm",
  target: "node22",
  banner: { js: esmRequire },
  entryPoints: [join(root, "src", "plugin.ts")],
  outfile: join(elgatoDir, "bin", "plugin.js"),
  plugins: [restartPlugin],
};
// VSD Craft 同梱の Node は 20 系。CommonJS にしておけば package.json の "type" に左右されない
const vsdOptions = {
  ...common,
  format: "cjs",
  target: "node20",
  entryPoints: [join(root, "src", "vsd.ts")],
  outfile: join(vsdDir, "bin", "plugin.js"),
};
const cliOptions = {
  ...common,
  format: "esm",
  target: "node20",
  banner: { js: `#!/usr/bin/env node\n${esmRequire}` },
  entryPoints: [join(root, "src", "cli.ts")],
  outfile: join(root, "dist", "herdr-deck.mjs"),
};

// Stream Deck 側の bin/plugin.js を ES Module として読ませるため
mkdirSync(join(elgatoDir, "bin"), { recursive: true });
writeFileSync(join(elgatoDir, "bin", "package.json"), '{ "type": "module" }\n');
// VSD 側は CommonJS。親ディレクトリに type: module があっても CommonJS として読ませる
mkdirSync(join(vsdDir, "bin"), { recursive: true });
writeFileSync(join(vsdDir, "bin", "package.json"), '{ "type": "commonjs" }\n');
// 設定画面は共通
cpSync(join(elgatoDir, "ui"), join(vsdDir, "ui"), { recursive: true });

const all = [elgatoOptions, vsdOptions, cliOptions];
if (watch) {
  const contexts = await Promise.all(all.map((o) => esbuild.context(o)));
  await Promise.all(contexts.map((c) => c.watch()));
} else {
  await Promise.all(all.map((o) => esbuild.build(o)));
  for (const dir of [elgatoDir, vsdDir]) {
    execFileSync(process.execPath, [join(root, "dist", "herdr-deck.mjs"), "icons", dir], { stdio: "inherit" });
  }
}
