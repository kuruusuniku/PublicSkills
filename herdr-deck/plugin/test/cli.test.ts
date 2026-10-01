import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import type { MockServer } from "./helpers.ts";
import { llmHandler, makeSnapshot, mockServer, voicevoxHandler } from "./helpers.ts";

// ビルド済みかどうかに関係なく、CLI を一時ディレクトリにバンドルしてから実際のプロセスとして動かす
const root = fileURLToPath(new URL("..", import.meta.url));
const FAKE = join(root, "test", "fixtures", "fake-herdr.mjs");

describe("herdr-deck CLI (E2E)", () => {
  let dir: string;
  let cli: string;
  let llm: MockServer;
  let vv: MockServer;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "herdr-deck-cli-"));
    cli = join(dir, "herdr-deck.mjs");
    await esbuild.build({
      entryPoints: [join(root, "src", "cli.ts")],
      outfile: cli,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      logLevel: "silent",
    });
    llm = await mockServer(llmHandler("全部のテストが通ったのだ。次はコミットするのだ。"));
    vv = await mockServer(voicevoxHandler());
    writeFileSync(
      join(dir, "state.json"),
      JSON.stringify({
        snapshot: makeSnapshot([
          { label: "api", tabs: [{ label: "claude", agents: [{ status: "done", completion: 2 }], focused: true }, { label: "logs" }] },
          { label: "web", tabs: [{ label: "codex", agents: [{ status: "blocked", agent: "codex" }] }] },
        ]),
        screens: { "w1:p1": "✓ 42 tests passed\n> ", "w2:p1": "Allow write to package.json? (y/n)" },
      }),
    );
  });
  after(async () => {
    await llm.close();
    await vv.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function run(args: string[], cfg: object, env: NodeJS.ProcessEnv = {}) {
    const cfgPath = join(dir, `cfg-${Math.random()}.json`);
    writeFileSync(cfgPath, JSON.stringify(cfg));
    return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      execFile(
        process.execPath,
        [cli, ...args, "--config", cfgPath],
        { env: { ...process.env, FAKE_HERDR_STATE: join(dir, "state.json"), ...env }, timeout: 20000 },
        (err, stdout, stderr) => resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr }),
      );
    });
  }

  const baseCfg = () => ({
    herdr: { path: FAKE },
    llm: { baseUrl: `${llm.url}/v1` },
    voice: { voicevox: { url: vv.url }, player: [process.execPath, "-e", "process.exit(0)", "{file}"] },
  });

  it("status: タブと状態を一覧する", async () => {
    const r = await run(["status"], baseCfg());
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /1\. 🟢 完了.*api \/ claude \[claude\]  ← 表示中/);
    assert.match(r.stdout, /2\. ⚫ ─.*api \/ logs/);
    assert.match(r.stdout, /3\. 🔴 確認待ち.*web \[codex\]/);
  });

  it("status: herdr が動いていなければ失敗する", async () => {
    const r = await run(["status"], baseCfg(), { FAKE_HERDR_STATE: "" });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /herdr サーバーに接続できません/);
  });

  it("narrate: 画面を読んで LLM で要約し、VOICEVOX で再生する", async () => {
    const r = await run(["narrate", "w2:p1", "--kind", "blocked"], baseCfg());
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /LLM \/ voicevox: web、全部のテストが通ったのだ。/);
    const chat = llm.requests.filter((q) => q.path === "/v1/chat/completions").pop()!;
    assert.match(JSON.parse(chat.body).messages[1].content, /Allow write to package\.json/);
  });

  it("say: VOICEVOX で読み上げる", async () => {
    const r = await run(["say", "テストなのだ"], baseCfg());
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /✓ voicevox で読み上げました: テストなのだ/);
  });

  it("doctor: 全部そろっていれば OK", async () => {
    const r = await run(["doctor"], baseCfg());
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /✓ herdr 0\.9\.3 に接続 \(ワークスペース 2 \/ タブ 3 \/ エージェント 2\)/);
    assert.match(r.stdout, /✓ LLM .* にモデル gemma3:4b があります/);
    assert.match(r.stdout, /✓ VOICEVOX .*: ずんだもん\(ノーマル\) id=3/);
  });

  it("doctor: モデルが無い・VOICEVOX が無いと教えてくれる", async () => {
    const r = await run(["doctor"], { ...baseCfg(), llm: { baseUrl: `${llm.url}/v1`, model: "nope:1b" }, voice: { voicevox: { url: "http://127.0.0.1:9" } } });
    assert.equal(r.code, 1);
    assert.match(r.stdout, /モデル nope:1b がありません \(あるもの: gemma3:4b\)/);
    assert.match(r.stdout, /ollama pull nope:1b/);
    assert.match(r.stdout, /✗ VOICEVOX .* に繋がりません/);
  });

  it("watch --quiet: 状態の変化を表示し続け、SIGINT で終わる", async () => {
    const cfgPath = join(dir, "watch.json");
    writeFileSync(cfgPath, JSON.stringify({ ...baseCfg(), herdr: { path: FAKE, pollMs: 300 } }));
    const child = execFile(process.execPath, [cli, "watch", "--quiet", "--config", cfgPath], {
      env: { ...process.env, FAKE_HERDR_STATE: join(dir, "state.json") },
    });
    let out = "";
    child.stdout!.on("data", (d) => (out += d));
    await new Promise((r) => setTimeout(r, 1500));
    child.kill("SIGINT");
    const code = await new Promise((r) => child.on("exit", r));
    assert.equal(code, 0);
    assert.match(out, /確認待ち/);
    assert.equal(out.match(/web \[codex\]/g)?.length, 1, "変化が無ければ同じ表を何度も出さない");
  });
});
