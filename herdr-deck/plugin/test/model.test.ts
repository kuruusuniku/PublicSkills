import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildTabViews, EventDetector } from "../src/core/model.ts";
import { assignSlots } from "../src/core/slots.ts";
import { makeSnapshot } from "./helpers.ts";

describe("buildTabViews", () => {
  it("herdr のサイドバー順 (ワークスペース→タブ) に並べる", () => {
    const snap = makeSnapshot([
      { label: "api", tabs: [{ label: "claude", agents: [{ status: "working" }] }, { label: "logs" }] },
      { label: "web", tabs: [{ label: "codex", agents: [{ status: "done", agent: "codex" }] }] },
    ]);
    const views = buildTabViews(snap);
    assert.deepEqual(
      views.map((v) => [v.workspaceLabel, v.tabLabel, v.state, v.multiTab]),
      [
        ["api", "claude", "working", true],
        ["api", "logs", "none", true],
        ["web", "codex", "done", false],
      ],
    );
    assert.equal(views[2].agentLabel, "codex");
    assert.equal(views[1].attentionPaneId, null);
  });

  it('"agents" ならエージェントのいないタブを飛ばす', () => {
    const snap = makeSnapshot([{ label: "api", tabs: [{ label: "claude", agents: [{ status: "idle" }] }, { label: "logs" }] }]);
    assert.deepEqual(buildTabViews(snap, "agents").map((v) => v.tabLabel), ["claude"]);
  });

  it("1タブに複数エージェントがいれば 確認待ち > 完了 > 作業中 > 待機 の順で代表を選ぶ", () => {
    const snap = makeSnapshot([
      {
        label: "api",
        tabs: [
          { label: "a", agents: [{ status: "working" }, { status: "done" }, { status: "idle" }] },
          { label: "b", agents: [{ status: "idle" }, { status: "blocked" }, { status: "done" }] },
        ],
      },
    ]);
    const [a, b] = buildTabViews(snap);
    assert.equal(a.state, "done");
    assert.equal(a.attentionPaneId, "w1:p2");
    assert.equal(a.agentCount, 3);
    assert.equal(b.state, "blocked");
    assert.equal(b.attentionPaneId, "w1:p5");
  });

  it("ワークスペース順に並んでいないタブ配列でも並べ直す", () => {
    const snap = makeSnapshot([
      { label: "one", tabs: [{ label: "a" }] },
      { label: "two", tabs: [{ label: "b" }] },
    ]);
    snap.tabs.reverse();
    assert.deepEqual(buildTabViews(snap).map((v) => v.workspaceLabel), ["one", "two"]);
  });
});

describe("EventDetector", () => {
  const ws = (status: Parameters<typeof makeSnapshot>[0][0]["tabs"][0]["agents"]) =>
    makeSnapshot([{ label: "api", tabs: [{ label: "claude", agents: status }] }]);

  it("最初のスナップショットでは読み上げない", () => {
    const d = new EventDetector();
    assert.deepEqual(d.update(ws([{ status: "blocked", seq: 3 }])), []);
    assert.deepEqual(d.update(ws([{ status: "done", completion: 5, seq: 5 }])).map((e) => e.kind), ["done"]);
  });

  it("completion_seq が新しくなったら完了を出す (間に working を挟んでも1回)", () => {
    const d = new EventDetector({ cooldownMs: 0 });
    d.update(ws([{ status: "working", seq: 1 }]));
    const events = d.update(ws([{ status: "done", completion: 2, seq: 2 }]));
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, "done");
    assert.equal(events[0].paneId, "w1:p1");
    assert.equal(events[0].workspaceLabel, "api");
    // 既読になって idle になっても completion_seq は同じなので出さない
    assert.deepEqual(d.update(ws([{ status: "idle", completion: 2, seq: 2 }])), []);
  });

  it("ポーリングの間に 完了→次の作業 まで進んでいたら完了は言わない", () => {
    const d = new EventDetector({ cooldownMs: 0 });
    d.update(ws([{ status: "working", seq: 1 }]));
    assert.deepEqual(d.update(ws([{ status: "working", completion: null, seq: 3 }])), []);
  });

  it("確認待ちに入ったら出す。確認待ちのままなら繰り返さない", () => {
    const d = new EventDetector({ cooldownMs: 0 });
    d.update(ws([{ status: "working", seq: 1 }]));
    assert.deepEqual(d.update(ws([{ status: "blocked", seq: 2 }])).map((e) => e.kind), ["blocked"]);
    assert.deepEqual(d.update(ws([{ status: "blocked", seq: 2 }])), []);
    // 一度抜けてまた確認待ち (state_change_seq が進む)
    assert.deepEqual(d.update(ws([{ status: "blocked", seq: 4 }])).map((e) => e.kind), ["blocked"]);
  });

  it("確認待ち→回答→完了 で両方出す", () => {
    const d = new EventDetector({ cooldownMs: 0 });
    d.update(ws([{ status: "working", seq: 1 }]));
    d.update(ws([{ status: "blocked", seq: 2 }]));
    d.update(ws([{ status: "working", seq: 3 }]));
    assert.deepEqual(d.update(ws([{ status: "done", completion: 4, seq: 4 }])).map((e) => e.kind), ["done"]);
  });

  it("同じペインの同じ出来事はクールダウン中は1回にまとめる", () => {
    let now = 0;
    const d = new EventDetector({ cooldownMs: 5000, now: () => now });
    d.update(ws([{ status: "working", seq: 1 }]));
    assert.equal(d.update(ws([{ status: "done", completion: 2, seq: 2 }])).length, 1);
    now = 1000;
    d.update(ws([{ status: "working", seq: 3 }]));
    assert.equal(d.update(ws([{ status: "done", completion: 4, seq: 4 }])).length, 0);
    now = 7000;
    d.update(ws([{ status: "working", seq: 5 }]));
    assert.equal(d.update(ws([{ status: "done", completion: 6, seq: 6 }])).length, 1);
  });

  it("後から現れたエージェントは、確認待ちなら知らせ、完了済みなら黙る", () => {
    const d = new EventDetector({ cooldownMs: 0 });
    d.update(makeSnapshot([{ label: "api", tabs: [{ label: "a" }] }]));
    const events = d.update(
      makeSnapshot([{ label: "api", tabs: [{ label: "a", agents: [{ status: "blocked", seq: 1 }, { status: "done", completion: 1 }] }] }]),
    );
    assert.deepEqual(events.map((e) => e.kind), ["blocked"]);
  });

  it("reset 後は再び最初のスナップショットを黙って取り込む", () => {
    const d = new EventDetector({ cooldownMs: 0 });
    d.update(ws([{ status: "working", seq: 1 }]));
    d.reset();
    assert.deepEqual(d.update(ws([{ status: "blocked", seq: 2 }])), []);
  });
});

describe("assignSlots", () => {
  it("指定なしのボタンは 行→列 の順に番号を振る", () => {
    const slots = assignSlots([
      { id: "c", device: "d", row: 1, column: 0 },
      { id: "b", device: "d", row: 0, column: 2 },
      { id: "a", device: "d", row: 0, column: 0 },
    ]);
    assert.deepEqual([slots.get("a"), slots.get("b"), slots.get("c")], [0, 1, 2]);
  });

  it("番号指定のボタンを優先し、残りは空き番号を埋める", () => {
    const slots = assignSlots([
      { id: "a", device: "d", row: 0, column: 0 },
      { id: "b", device: "d", row: 0, column: 1, slot: 1 },
      { id: "c", device: "d", row: 0, column: 2 },
    ]);
    assert.deepEqual([slots.get("a"), slots.get("b"), slots.get("c")], [1, 0, 2]);
  });
});
