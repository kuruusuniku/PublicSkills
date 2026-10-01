import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { ConfigStore } from "../src/core/config.ts";
import { buildMessages, cleanForSpeech, fallbackText, prepareScreen, summarize } from "../src/core/llm.ts";
import { Narrator } from "../src/core/narrator.ts";
import type { NarrationEvent } from "../src/core/types.ts";
import { silentLogger } from "../src/core/types.ts";
import type { MockServer } from "./helpers.ts";
import { llmHandler, mockServer, voicevoxHandler } from "./helpers.ts";

const event = (over: Partial<NarrationEvent> = {}): NarrationEvent => ({
  kind: "done",
  paneId: "w1:p1",
  tabId: "w1:t1",
  workspaceId: "w1",
  workspaceLabel: "api",
  tabLabel: "claude",
  multiTab: false,
  agentLabel: "claude",
  focused: false,
  ...over,
});

describe("cleanForSpeech", () => {
  it("思考タグ・コード・URL・パス・記号を読まない", () => {
    const out = cleanForSpeech(
      "<think>考え中</think>ずんだもん: `npm test` を **実行** したのだ。https://example.com と src/core/model.ts を見たのだ。",
      200,
    );
    assert.equal(out, "npm test を 実行 したのだ。 と を見たのだ。");
  });

  it("長すぎたら文の切れ目で切る", () => {
    const out = cleanForSpeech("ビルドが終わったのだ。テストも通ったのだ。次はプルリクエストを作ってレビューをお願いするといいのだ。", 30);
    assert.equal(out, "ビルドが終わったのだ。テストも通ったのだ。");
  });

  it("切れ目が無ければ省略して締める", () => {
    assert.equal(cleanForSpeech("あ".repeat(50), 10), "あ".repeat(10) + "…なのだ。");
  });
});

describe("prepareScreen", () => {
  it("末尾の空行を落とし、最新の行を残し、ANSI を消す", () => {
    const raw = ["old1", "old2", "\u001b[32m✓ tests passed\u001b[0m", "", "", "> ", "", ""].join("\n");
    assert.equal(prepareScreen(raw, 3), "✓ tests passed\n\n>");
  });
});

describe("buildMessages", () => {
  it("system にずんだもんの口調、user に状態と画面を入れる", () => {
    const cfg = new ConfigStore(join(tmpdir(), "none", "c.json")).get().llm;
    const [sys, user] = buildMessages(event({ kind: "blocked", multiTab: true }), "Allow edit? (y/n)", cfg);
    assert.match(sys.content, /のだ/);
    assert.match(sys.content, /110文字以内/);
    assert.match(user.content, /確認待ち/);
    assert.match(user.content, /api \/ claude/);
    assert.match(user.content, /Allow edit\? \(y\/n\)/);
  });

  it("定型文", () => {
    assert.match(fallbackText(event()), /終わったのだ/);
    assert.match(fallbackText(event({ kind: "blocked" })), /確認を待っている/);
    assert.match(fallbackText(event({ kind: "status", state: "working" })), /作業中なのだ/);
  });
});

describe("Narrator (偽 LLM / 偽 VOICEVOX)", () => {
  let dir: string;
  let llm: MockServer;
  let vv: MockServer;
  const servers: MockServer[] = [];

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "herdr-deck-narr-"));
    llm = await mockServer(llmHandler("<think>ふむ</think>テストを直して全部通したのだ。次はコミットするといいのだ。"));
    vv = await mockServer(voicevoxHandler());
  });
  after(async () => {
    await llm.close();
    await vv.close();
    rmSync(dir, { recursive: true, force: true });
  });
  afterEach(async () => {
    for (const s of servers.splice(0)) await s.close();
  });

  function setup(cfg: object, screens: Record<string, string> = { "w1:p1": "All 42 tests passed\n> " }) {
    const path = join(dir, `${Math.random()}.json`);
    writeFileSync(path, JSON.stringify(cfg));
    const played: Buffer[] = [];
    const said: string[] = [];
    const reads: string[] = [];
    const narrator = new Narrator({
      config: new ConfigStore(path),
      herdr: {
        async readPane(id: string) {
          reads.push(id);
          if (!(id in screens)) throw new Error("pane not found");
          return screens[id];
        },
      },
      logger: silentLogger,
      play: async (wav) => {
        played.push(wav);
      },
      say: async (t) => {
        said.push(t);
        return true;
      },
    });
    return { narrator, played, said, reads };
  }

  it("画面 → LLM 要約 → VOICEVOX → 再生 まで通る", async () => {
    const { narrator, played } = setup({ llm: { baseUrl: `${llm.url}/v1` }, voice: { voicevox: { url: vv.url, speedScale: 1.3 } } });
    const res = await narrator.narrate(event());
    assert.equal(res.source, "llm");
    assert.equal(res.voice, "voicevox");
    assert.equal(res.text, "api、テストを直して全部通したのだ。次はコミットするといいのだ。");
    assert.equal(played.length, 1);
    assert.equal(played[0].subarray(0, 4).toString(), "RIFF");

    const chat = llm.requests.find((r) => r.path === "/v1/chat/completions")!;
    const body = JSON.parse(chat.body);
    assert.equal(body.model, "gemma3:4b");
    assert.match(body.messages[1].content, /All 42 tests passed/);

    const query = vv.requests.find((r) => r.path.startsWith("/audio_query"))!;
    assert.match(decodeURIComponent(query.path), /speaker=3/);
    const synth = vv.requests.find((r) => r.path.startsWith("/synthesis"))!;
    assert.equal(JSON.parse(synth.body).speedScale, 1.3);
  });

  it("LLM が落ちていても定型文で読み上げる", async () => {
    const { narrator, played } = setup({ llm: { baseUrl: "http://127.0.0.1:9/v1", timeoutMs: 2000 }, voice: { voicevox: { url: vv.url } } });
    const res = await narrator.narrate(event({ kind: "blocked" }));
    assert.equal(res.source, "fallback");
    assert.equal(res.voice, "voicevox");
    assert.match(res.text, /^api、claudeが確認を待っているのだ/);
    assert.equal(played.length, 1);
  });

  it("VOICEVOX が落ちていたら say で代わりに読む / fallbackSay=false なら黙る", async () => {
    const broken = await mockServer(voicevoxHandler({ fail: true }));
    servers.push(broken);
    const a = setup({ llm: { enabled: false }, voice: { voicevox: { url: broken.url } } });
    assert.equal((await a.narrator.narrate(event())).voice, "say");
    assert.equal(a.said.length, 1);
    const b = setup({ llm: { enabled: false }, voice: { voicevox: { url: broken.url }, fallbackSay: false } });
    assert.equal((await b.narrator.narrate(event())).voice, "none");
  });

  it("キュー: 1件ずつ順番に。設定で無効なもの・フォーカス中はスキップ", async () => {
    const { narrator, played, reads } = setup(
      { llm: { baseUrl: `${llm.url}/v1` }, voice: { voicevox: { url: vv.url }, announce: ["done"], skipFocused: true } },
      { "w1:p1": "a", "w1:p2": "b" },
    );
    assert.equal(narrator.enqueue(event({ kind: "blocked" })), false, "announce に無い");
    assert.equal(narrator.enqueue(event({ focused: true })), false, "フォーカス中");
    assert.equal(narrator.enqueue(event({ kind: "status", focused: true })), true, "長押しは設定に関係なく答える");
    assert.equal(narrator.enqueue(event({ paneId: "w1:p2" })), true);
    await narrator.idle();
    assert.deepEqual(reads, ["w1:p1", "w1:p2"]);
    assert.equal(played.length, 2);
  });

  it("voice.enabled=false なら何もしない", () => {
    const { narrator } = setup({ voice: { enabled: false } });
    assert.equal(narrator.enqueue(event()), false);
  });
});

describe("summarize", () => {
  it("API キーがあれば Authorization を付け、HTTP エラーは例外にする", async () => {
    let auth = "";
    const server = await mockServer((req, _b, res) => {
      auth = String(req.headers.authorization);
      res.statusCode = 404;
      res.end('{"error":"model not found"}');
    });
    try {
      const cfg = new ConfigStore(join(tmpdir(), "none", "c.json")).get().llm;
      await assert.rejects(
        summarize(event(), "screen", { ...cfg, baseUrl: server.url, apiKey: "sk-test" }),
        /LLM 404: \{"error":"model not found"\}/,
      );
      assert.equal(auth, "Bearer sk-test");
    } finally {
      await server.close();
    }
  });
});
