import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { ConfigStore } from "../src/core/config.ts";
import { augmentedPath, findExecutable, HerdrClient, HerdrError } from "../src/core/herdr.ts";
import { HerdrMonitor } from "../src/core/monitor.ts";
import type { NarrationEvent, SessionSnapshot } from "../src/core/types.ts";
import { silentLogger } from "../src/core/types.ts";
import { makeSnapshot } from "./helpers.ts";

const FAKE = fileURLToPath(new URL("./fixtures/fake-herdr.mjs", import.meta.url));

describe("HerdrClient (偽 herdr を実際に起動)", () => {
  let dir: string;
  let stateFile: string;
  let logFile: string;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "herdr-deck-herdr-"));
    stateFile = join(dir, "state.json");
    logFile = join(dir, "calls.log");
    process.env.FAKE_HERDR_LOG = logFile;
  });
  after(() => {
    delete process.env.FAKE_HERDR_STATE;
    delete process.env.FAKE_HERDR_LOG;
    rmSync(dir, { recursive: true, force: true });
  });

  const setState = (snapshot: SessionSnapshot, screens: Record<string, string> = {}) => {
    writeFileSync(stateFile, JSON.stringify({ snapshot, screens }));
    process.env.FAKE_HERDR_STATE = stateFile;
  };
  const calls = () =>
    readFileSync(logFile, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { args: string[]; session: string | null });

  it("api snapshot を読み、pane read / agent focus / tab focus を正しい引数で叩く", async () => {
    setState(makeSnapshot([{ label: "api", tabs: [{ label: "claude", agents: [{ status: "done", completion: 3 }] }] }]), {
      "w1:p1": "テストが全部通りました\n",
    });
    const herdr = new HerdrClient({ bin: FAKE, session: "work", timeoutMs: 5000 });
    const snap = await herdr.snapshot();
    assert.equal(snap.agents[0].agent_status, "done");
    assert.equal(await herdr.readPane("w1:p1", 80), "テストが全部通りました\n");
    await herdr.focusAgent("w1:p1");
    await herdr.focusTab("w1:t1");
    const log = calls().slice(-4);
    assert.deepEqual(log.map((c) => c.args), [
      ["api", "snapshot"],
      ["pane", "read", "w1:p1", "--source", "recent-unwrapped", "--lines", "80"],
      ["agent", "focus", "w1:p1"],
      ["tab", "focus", "w1:t1"],
    ]);
    assert.ok(log.every((c) => c.session === "work"), "HERDR_SESSION を渡す");
  });

  it("サーバーのエラー JSON (stderr) をコード付きのエラーにする", async () => {
    setState(makeSnapshot([{ label: "api", tabs: [{ label: "a" }] }]));
    const herdr = new HerdrClient({ bin: FAKE, session: null, timeoutMs: 5000 });
    await assert.rejects(herdr.focusAgent("w9:p9"), (e: HerdrError) => e.code === "agent_not_found");
  });

  it("サーバーが動いていなければ server_unavailable", async () => {
    delete process.env.FAKE_HERDR_STATE;
    const herdr = new HerdrClient({ bin: FAKE, session: null, timeoutMs: 5000 });
    await assert.rejects(herdr.snapshot(), (e: HerdrError) => e.code === "server_unavailable");
  });

  it("バイナリが無ければ herdr_not_found", async () => {
    const herdr = new HerdrClient({ bin: join(dir, "nope"), session: null, timeoutMs: 5000 });
    await assert.rejects(herdr.snapshot(), (e: HerdrError) => e.code === "herdr_not_found");
  });
});

describe("PATH の補完", () => {
  it("Stream Deck の最小 PATH に herdr の既定インストール先を足す", () => {
    const p = augmentedPath("/usr/bin:/bin", "darwin");
    assert.ok(p.startsWith("/usr/bin:/bin:"));
    assert.ok(p.includes("/.local/bin"));
    assert.ok(p.includes("/opt/homebrew/bin"));
    assert.equal(augmentedPath(p, "darwin"), p, "何度呼んでも増えない");
  });

  it("findExecutable は実行可能なファイルだけを見つける", () => {
    assert.ok(findExecutable("node", process.env.PATH ?? ""));
    assert.equal(findExecutable("definitely-not-a-command-xyz", "/usr/bin"), null);
    assert.equal(findExecutable(process.execPath, ""), process.execPath, "絶対パスはそのまま確かめる");
    assert.equal(findExecutable("/nonexistent/bin/player", "/usr/bin"), null);
  });
});

describe("HerdrMonitor", () => {
  /** スナップショットを順番に返す偽クライアント */
  function scripted(steps: (SessionSnapshot | Error)[]) {
    let i = 0;
    const client = {
      configure() {},
      async snapshot() {
        const s = steps[Math.min(i++, steps.length - 1)];
        if (s instanceof Error) throw s;
        return structuredClone(s);
      },
    };
    return client as unknown as HerdrClient;
  }
  const config = () => new ConfigStore(join(tmpdir(), "herdr-deck-none", "config.json"));
  const snap = (status: "working" | "done" | "blocked", completion: number | null, seq: number) =>
    makeSnapshot([{ label: "api", tabs: [{ label: "claude", agents: [{ status, completion, seq }] }] }]);

  it("update でタブ一覧、完了で narration を出す", async () => {
    const m = new HerdrMonitor(scripted([snap("working", null, 1), snap("done", 2, 2)]), config(), silentLogger);
    const events: NarrationEvent[] = [];
    let updates = 0;
    m.on("update", () => updates++);
    m.on("narration", (e) => events.push(e));
    await m.pollOnce();
    await m.pollOnce();
    assert.equal(updates, 2);
    assert.equal(m.online, true);
    assert.deepEqual(events.map((e) => e.kind), ["done"]);
    assert.equal(m.tabs[0].state, "done");
  });

  it("切断で offline を1回だけ出し、再接続直後はしゃべらない", async () => {
    const down = new HerdrError("herdr サーバーに接続できません", "server_unavailable");
    const m = new HerdrMonitor(
      scripted([snap("working", null, 1), down, down, snap("blocked", null, 5), snap("blocked", null, 5)]),
      config(),
      silentLogger,
    );
    let offline = 0;
    const events: NarrationEvent[] = [];
    m.on("offline", () => offline++);
    m.on("narration", (e) => events.push(e));
    for (let i = 0; i < 5; i++) await m.pollOnce();
    assert.equal(offline, 1);
    assert.equal(m.online, true);
    assert.deepEqual(events, [], "再接続後の最初のスナップショットは取り込むだけ");
  });

  it("herdr サーバーが入れ替わったら (version が変わったら) 取り直す", async () => {
    const a = snap("working", null, 1);
    const b = snap("blocked", null, 1);
    b.version = "0.9.4";
    const m = new HerdrMonitor(scripted([a, b]), config(), silentLogger);
    const events: NarrationEvent[] = [];
    m.on("narration", (e) => events.push(e));
    await m.pollOnce();
    await m.pollOnce();
    assert.deepEqual(events, []);
  });

  it("start/stop でループが止まる", async () => {
    const m = new HerdrMonitor(scripted([snap("working", null, 1)]), config(), silentLogger);
    let updates = 0;
    m.on("update", () => updates++);
    m.start();
    await new Promise((r) => setTimeout(r, 50));
    m.stop();
    const n = updates;
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(n >= 1);
    assert.equal(updates, n);
  });
});
