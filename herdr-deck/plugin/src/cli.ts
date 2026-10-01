import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { ConfigStore, defaultConfigPath } from "./core/config.ts";
import { augmentedPath, findExecutable, HerdrClient } from "./core/herdr.ts";
import { isLocalEndpoint, listModels } from "./core/llm.ts";
import { STATE_LABEL } from "./core/model.ts";
import { HerdrMonitor } from "./core/monitor.ts";
import { Narrator } from "./core/narrator.ts";
import { defaultPlayer } from "./core/player.ts";
import { renderIconPng } from "./core/png.ts";
import { renderKeySvg } from "./core/render.ts";
import type { Logger, NarrationKind, TabView } from "./core/types.ts";
import { listStyles } from "./core/voicevox.ts";

const HELP = `herdr-deck — herdr の状態監視とずんだもん読み上げ (Stream Deck なしでも使える)

使い方: herdr-deck <command> [options]

  status                 herdr のタブと状態を1回表示する
  watch [--quiet]        監視を続け、完了・確認待ちをずんだもんが読み上げる (Stream Deck 不要)
  say <text>             VOICEVOX で文章を読み上げる (音声まわりの確認用)
  narrate <pane_id> [--kind done|blocked|status]
                         そのペインの画面を LLM で要約して読み上げる (LLM の確認用)
  doctor                 herdr / ローカル LLM / VOICEVOX / 再生コマンドを点検する
  init                   設定ファイルを既定値で作る
  preview [--out DIR]    ボタンの絵を SVG で書き出す (見た目の確認用)
  icons <sdPlugin dir>   プラグインのアイコン PNG を作る (ビルドが使う)

共通オプション:
  --config PATH          設定ファイル (既定: ${defaultConfigPath()})
  -v, --verbose          詳しいログ
`;

function makeLogger(verbose: boolean): Logger {
  const ts = () => new Date().toLocaleTimeString("ja-JP", { hour12: false });
  return {
    debug: (...a) => verbose && console.error(`${ts()} debug`, ...a),
    info: (...a) => console.error(`${ts()}`, ...a),
    warn: (...a) => console.error(`${ts()} 警告`, ...a),
    error: (...a) => console.error(`${ts()} エラー`, ...a),
  };
}

const ICON: Record<string, string> = { working: "🔵", blocked: "🔴", done: "🟢", idle: "⚪", unknown: "🟣", none: "⚫" };

function formatTabs(tabs: TabView[]): string {
  if (tabs.length === 0) return "  (タブがありません)";
  return tabs
    .map((t, i) => {
      const where = t.multiTab ? `${t.workspaceLabel} / ${t.tabLabel}` : t.workspaceLabel;
      const who = t.agentLabel ? ` [${t.agentLabel}${t.agentCount > 1 ? ` 他${t.agentCount - 1}` : ""}]` : "";
      return `  ${String(i + 1).padStart(2)}. ${ICON[t.state]} ${STATE_LABEL[t.state].padEnd(4, "　")} ${where}${who}${t.focused ? "  ← 表示中" : ""}`;
    })
    .join("\n");
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      config: { type: "string" },
      verbose: { type: "boolean", short: "v" },
      quiet: { type: "boolean", short: "q" },
      kind: { type: "string" },
      out: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [command, ...rest] = positionals;
  if (!command || values.help) {
    console.log(HELP);
    return command ? 0 : 1;
  }

  const logger = makeLogger(!!values.verbose);
  const config = new ConfigStore(values.config ?? defaultConfigPath(), logger);
  const cfg = config.get();
  const herdr = new HerdrClient({ bin: cfg.herdr.path, session: cfg.herdr.session, timeoutMs: cfg.herdr.timeoutMs });
  const narrator = new Narrator({ config, herdr, logger });

  switch (command) {
    case "status": {
      const monitor = new HerdrMonitor(herdr, config, logger);
      await monitor.pollOnce();
      if (!monitor.online) return 1;
      console.log(formatTabs(monitor.tabs));
      return 0;
    }

    case "watch": {
      const monitor = new HerdrMonitor(herdr, config, logger);
      let last = "";
      monitor.on("update", (tabs) => {
        const text = formatTabs(tabs);
        if (text !== last) {
          last = text;
          console.log(`\n${new Date().toLocaleTimeString("ja-JP", { hour12: false })}\n${text}`);
        }
      });
      monitor.on("narration", (ev) => {
        if (values.quiet) logger.info(`[${ev.kind}] ${ev.workspaceLabel} / ${ev.tabLabel} (${ev.agentLabel})`);
        else narrator.enqueue(ev);
      });
      monitor.start();
      logger.info(`herdr を ${cfg.herdr.pollMs}ms ごとに監視しています (Ctrl+C で終了)`);
      await new Promise<void>((resolveStop) => {
        process.once("SIGINT", () => resolveStop());
        process.once("SIGTERM", () => resolveStop());
      });
      monitor.stop();
      return 0;
    }

    case "say": {
      const text = rest.join(" ").trim() || "ボクはずんだもんなのだ。準備はばっちりなのだ。";
      const voice = await narrator.speak(text);
      console.log(`${voice === "none" ? "✗ 読み上げられませんでした" : `✓ ${voice} で読み上げました`}: ${text}`);
      return voice === "none" ? 1 : 0;
    }

    case "narrate": {
      const paneId = rest[0];
      if (!paneId) {
        console.error("pane_id を指定してください (herdr-deck status や herdr pane list で確認できます)");
        return 2;
      }
      const kind = (values.kind ?? "status") as NarrationKind;
      if (!["done", "blocked", "status"].includes(kind)) {
        console.error("--kind は done / blocked / status のどれかです");
        return 2;
      }
      const snapshot = await herdr.snapshot();
      const agent = snapshot.agents.find((a) => a.pane_id === paneId);
      const tab = snapshot.tabs.find((t) => t.tab_id === agent?.tab_id);
      const ws = snapshot.workspaces.find((w) => w.workspace_id === agent?.workspace_id);
      const result = await narrator.narrate({
        kind,
        paneId,
        tabId: tab?.tab_id ?? "",
        workspaceId: ws?.workspace_id ?? "",
        workspaceLabel: ws?.label ?? paneId,
        tabLabel: tab?.label ?? "",
        multiTab: (ws?.tab_count ?? 1) > 1,
        agentLabel: agent?.display_agent || agent?.agent || "agent",
        focused: agent?.focused ?? false,
        state: agent?.agent_status,
      });
      console.log(`${result.source === "llm" ? "LLM" : "定型文"} / ${result.voice}: ${result.text}`);
      return 0;
    }

    case "doctor":
      return doctor(config, herdr);

    case "init": {
      const created = config.ensureFile();
      console.log(created ? `作成しました: ${config.path}` : `すでにあります: ${config.path}`);
      return 0;
    }

    case "preview": {
      const out = resolve(values.out ?? "preview");
      mkdirSync(out, { recursive: true });
      const base: TabView = {
        tabId: "w1:t1",
        workspaceId: "w1",
        workspaceLabel: "PublicSkills",
        tabLabel: "claude",
        multiTab: false,
        state: "working",
        attentionPaneId: "w1:p1",
        agentLabel: "claude",
        agentCount: 1,
        focused: false,
      };
      const cases: [string, Parameters<typeof renderKeySvg>[0]][] = [];
      for (const state of ["working", "blocked", "done", "idle", "unknown", "none"] as const) {
        for (let frame = 0; frame < 6; frame++) cases.push([`${state}-${frame}`, { view: { ...base, state }, frame }]);
      }
      cases.push(["multitab-done-0", { view: { ...base, state: "done", multiTab: true, workspaceLabel: "とても長いワークスペース名", tabLabel: "review-agent-2" }, frame: 0 }]);
      cases.push(["offline-0", { view: null, offline: true, frame: 0 }]);
      cases.push(["empty-0", { view: null, slot: 7, frame: 0 }]);
      const cells: string[] = [];
      for (const [name, input] of cases) {
        const svg = renderKeySvg(input);
        writeFileSync(join(out, `${name}.svg`), svg);
        cells.push(`<figure><img src="${name}.svg" width="144" height="144"><figcaption>${name}</figcaption></figure>`);
      }
      writeFileSync(
        join(out, "index.html"),
        `<!doctype html><meta charset="utf-8"><title>herdr deck preview</title><style>body{background:#111;color:#ccc;font:12px sans-serif;display:flex;flex-wrap:wrap;gap:12px;padding:12px}figure{margin:0;text-align:center}img{border-radius:18px;display:block}</style>${cells.join("")}`,
      );
      console.log(`${cases.length} 枚を書き出しました: ${join(out, "index.html")}`);
      return 0;
    }

    case "icons": {
      const dir = rest[0];
      if (!dir) {
        console.error("sdPlugin ディレクトリを指定してください");
        return 2;
      }
      const write = (rel: string, png: Buffer) => {
        const p = join(dir, rel);
        mkdirSync(join(p, ".."), { recursive: true });
        writeFileSync(p, png);
      };
      for (const [suffix, k] of [["", 1], ["@2x", 2]] as const) {
        write(`imgs/plugin/icon${suffix}.png`, renderIconPng({ size: 256 * k, state: "done", background: "#15803d" }));
        write(`imgs/plugin/category${suffix}.png`, renderIconPng({ size: 28 * k, state: "idle", background: null, monochrome: true }));
        write(`imgs/actions/tab/icon${suffix}.png`, renderIconPng({ size: 20 * k, state: "idle", background: null, monochrome: true }));
        write(`imgs/actions/tab/key${suffix}.png`, renderIconPng({ size: 72 * k, state: "idle", background: "#334155" }));
      }
      return 0;
    }

    default:
      console.error(`不明なコマンド: ${command}\n`);
      console.log(HELP);
      return 2;
  }
}

async function doctor(config: ConfigStore, herdr: HerdrClient): Promise<number> {
  const cfg = config.get();
  let failures = 0;
  const ok = (msg: string) => console.log(`✓ ${msg}`);
  const ng = (msg: string, hint?: string) => {
    failures++;
    console.log(`✗ ${msg}${hint ? `\n    → ${hint}` : ""}`);
  };
  const warn = (msg: string) => console.log(`! ${msg}`);

  console.log(`設定ファイル: ${config.path}\n`);

  // herdr
  try {
    console.log(`herdr: ${herdr.binary()}`);
    const snap = await herdr.snapshot();
    ok(`herdr ${snap.version} に接続 (ワークスペース ${snap.workspaces.length} / タブ ${snap.tabs.length} / エージェント ${snap.agents.length})`);
    if (snap.protocol !== 22) warn(`herdr の API protocol が ${snap.protocol} です (動作確認は 22)。表示がおかしければ herdr を更新してください`);
  } catch (err) {
    ng(`herdr: ${(err as Error).message}`, "herdr を起動しているか、config.json の herdr.path を確認してください");
  }

  // LLM
  if (!cfg.llm.enabled) {
    warn("LLM 要約は無効です (llm.enabled = false)。定型文で読み上げます");
  } else {
    if (!isLocalEndpoint(cfg.llm.baseUrl)) warn(`LLM の送り先 ${cfg.llm.baseUrl} はローカルではありません。ターミナルの画面がそこへ送られます`);
    try {
      const models = await listModels(cfg.llm);
      if (models.includes(cfg.llm.model)) ok(`LLM ${cfg.llm.baseUrl} にモデル ${cfg.llm.model} があります`);
      else
        ng(
          `LLM ${cfg.llm.baseUrl} にモデル ${cfg.llm.model} がありません (あるもの: ${models.slice(0, 8).join(", ") || "なし"})`,
          `ollama pull ${cfg.llm.model} するか、config.json の llm.model を上のどれかにしてください`,
        );
    } catch (err) {
      ng(`LLM ${cfg.llm.baseUrl} に繋がりません: ${(err as Error).message}`, "Ollama / LM Studio を起動してください (止まっていても定型文で読み上げは続きます)");
    }
  }

  // VOICEVOX
  try {
    const styles = await listStyles(cfg.voice.voicevox);
    const style = styles.find((s) => s.id === cfg.voice.voicevox.speaker);
    if (style) ok(`VOICEVOX ${cfg.voice.voicevox.url}: ${style.speaker}(${style.style}) id=${style.id}`);
    else {
      const zunda = styles.filter((s) => s.speaker.includes("ずんだもん")).map((s) => `${s.style}=${s.id}`);
      ng(`VOICEVOX にスタイル id=${cfg.voice.voicevox.speaker} がありません`, `ずんだもん: ${zunda.join(", ") || "見つかりません"}`);
    }
  } catch (err) {
    ng(
      `VOICEVOX ${cfg.voice.voicevox.url} に繋がりません: ${(err as Error).message}`,
      "VOICEVOX (アプリか ENGINE) を起動してください" + (process.platform === "darwin" && cfg.voice.fallbackSay ? "。止まっている間は macOS の say で代わりに読みます" : ""),
    );
  }

  // 再生コマンド
  const player = cfg.voice.player ?? defaultPlayer();
  if (!player) ng("WAV を再生するコマンドが見つかりません", "config.json の voice.player に例えば [\"ffplay\", \"-nodisp\", \"-autoexit\", \"{file}\"] を設定してください");
  else if (process.platform !== "win32" && !findExecutable(player[0], augmentedPath())) ng(`再生コマンド ${player[0]} が見つかりません`);
  else ok(`再生コマンド: ${player.join(" ")}`);

  console.log(failures === 0 ? "\nすべて OK なのだ。" : `\n${failures} 件の問題があります。`);
  return failures === 0 ? 0 : 1;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error(`エラー: ${(err as Error).message}`);
    process.exit(1);
  },
);
