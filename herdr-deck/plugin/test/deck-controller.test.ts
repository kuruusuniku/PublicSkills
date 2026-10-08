import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { ConfigStore } from "../src/core/config.ts";
import { DeckController, LONG_PRESS_MS, parseSlot } from "../src/core/deck-controller.ts";
import { buildTabViews } from "../src/core/model.ts";
import { handleMessage, parseRegistrationArgs, protocolSink, TAB_ACTION_UUID } from "../src/core/sd-protocol.ts";
import type { NarrationEvent } from "../src/core/types.ts";
import { silentLogger } from "../src/core/types.ts";
import { makeSnapshot } from "./helpers.ts";

const dir = mkdtempSync(join(tmpdir(), "herdr-deck-ctl-"));
after(() => rmSync(dir, { recursive: true, force: true }));

function setup(cfg: object = {}) {
  const path = join(dir, `${Math.random()}.json`);
  writeFileSync(path, JSON.stringify(cfg));
  const tabs = buildTabViews(
    makeSnapshot([
      { label: "api", tabs: [{ label: "claude", agents: [{ status: "done", completion: 2 }] }, { label: "logs" }] },
      { label: "web", tabs: [{ label: "codex", agents: [{ status: "blocked" }] }] },
    ]),
  );
  const calls: string[] = [];
  const images = new Map<string, string>();
  const alerts: string[] = [];
  const narrations: NarrationEvent[] = [];
  let now = 0;
  const controller = new DeckController({
    config: new ConfigStore(path),
    herdr: {
      async focusAgent(id: string) {
        calls.push(`agent focus ${id}`);
      },
      async focusTab(id: string) {
        calls.push(`tab focus ${id}`);
      },
    },
    monitor: { tabs, online: true, async pollOnce() {} },
    narrator: {
      enqueue(ev: NarrationEvent) {
        narrations.push(ev);
        return true;
      },
    },
    logger: silentLogger,
    sink: { setImage: (id, img) => images.set(id, img), showAlert: (id) => alerts.push(id) },
    defaultImageFormat: "svg-raw",
    now: () => now,
  });
  return { controller, calls, images, alerts, narrations, advance: (ms: number) => (now += ms) };
}

const decode = (img: string) =>
  img.startsWith("data:image/svg+xml;base64,")
    ? Buffer.from(img.slice("data:image/svg+xml;base64,".length), "base64").toString()
    : img.slice("data:image/svg+xml;charset=utf8,".length);

describe("DeckController", () => {
  it("現れたボタンに位置順でタブを割り当てて描く", () => {
    const { controller, images } = setup();
    controller.keyAppear({ id: "b", device: "d", row: 0, column: 1, slot: null });
    controller.keyAppear({ id: "a", device: "d", row: 0, column: 0, slot: null });
    controller.keyAppear({ id: "c", device: "d", row: 0, column: 2, slot: null });
    controller.keyAppear({ id: "x", device: "d", row: 1, column: 0, slot: null });
    assert.match(decode(images.get("a")!), />完了</);
    assert.match(decode(images.get("b")!), />エージェント無し</);
    assert.match(decode(images.get("c")!), />確認待ち</);
    assert.match(decode(images.get("x")!), />空き</);
    assert.equal(controller.viewFor("c")?.workspaceLabel, "web");
  });

  it("タブ番号を指定したボタンはそのタブに固定する", () => {
    const { controller, images } = setup();
    controller.keyAppear({ id: "a", device: "d", row: 0, column: 0, slot: null });
    controller.keySettings("a", 3);
    assert.match(decode(images.get("a")!), />確認待ち</);
  });

  it("短押しで注目ペインへ、エージェントのいないタブはタブへ移動する", async () => {
    const { controller, calls } = setup();
    controller.keyAppear({ id: "a", device: "d", column: 0, slot: null });
    controller.keyAppear({ id: "b", device: "d", column: 1, slot: null });
    controller.keyDown("a");
    await controller.keyUp("a");
    controller.keyDown("b");
    await controller.keyUp("b");
    assert.deepEqual(calls, ["agent focus w1:p1", "tab focus w1:t2"]);
  });

  it("長押しで今の様子の読み上げを頼む", async () => {
    const { controller, calls, narrations, advance } = setup();
    controller.keyAppear({ id: "c", device: "d", column: 2, slot: 3 });
    controller.keyDown("c");
    advance(LONG_PRESS_MS + 10);
    await controller.keyUp("c");
    assert.deepEqual(calls, []);
    assert.equal(narrations.length, 1);
    assert.equal(narrations[0].kind, "status");
    assert.equal(narrations[0].state, "blocked");
    assert.equal(narrations[0].paneId, "w2:p1");
  });

  it("空きボタン・エージェントのいないタブの長押しは警告を出す", async () => {
    const { controller, alerts, advance } = setup();
    controller.keyAppear({ id: "x", device: "d", slot: 9 });
    await controller.keyUp("x");
    controller.keyAppear({ id: "b", device: "d", slot: 2 });
    controller.keyDown("b");
    advance(LONG_PRESS_MS);
    await controller.keyUp("b");
    assert.deepEqual(alerts, ["x", "b"]);
  });

  it("imageFormat: auto なら既定の形式、設定すればその形式", () => {
    const raw = setup();
    raw.controller.keyAppear({ id: "a", device: "d", slot: 1 });
    assert.ok(raw.images.get("a")!.startsWith("data:image/svg+xml;charset=utf8,<svg"));
    const b64 = setup({ deck: { imageFormat: "svg-base64" } });
    b64.controller.keyAppear({ id: "a", device: "d", slot: 1 });
    assert.ok(b64.images.get("a")!.startsWith("data:image/svg+xml;base64,"));
  });

  it("消えたボタンには描かない", () => {
    const { controller, images } = setup();
    controller.keyAppear({ id: "a", device: "d", slot: 1 });
    controller.keyDisappear("a");
    images.clear();
    controller.tick();
    assert.equal(images.size, 0);
    assert.equal(controller.keyCount, 0);
  });

  it("parseSlot", () => {
    assert.equal(parseSlot("3"), 3);
    assert.equal(parseSlot(2), 2);
    assert.equal(parseSlot(""), null);
    assert.equal(parseSlot(0), null);
    assert.equal(parseSlot(null), null);
  });
});

describe("Stream Deck 互換プロトコル (VSD Craft)", () => {
  it("起動引数を読む", () => {
    const args = parseRegistrationArgs([
      "/node",
      "plugin.js",
      "-port",
      "28196",
      "-pluginUUID",
      "ABC",
      "-registerEvent",
      "registerPlugin",
      "-info",
      '{"application":{"version":"3.10.191.0421"}}',
    ]);
    assert.deepEqual(args, { port: "28196", pluginUUID: "ABC", registerEvent: "registerPlugin", info: { application: { version: "3.10.191.0421" } } });
    assert.throws(() => parseRegistrationArgs(["node", "x", "-port", "1"]), /-pluginUUID, -registerEvent/);
  });

  it("メッセージをボタン操作に振り分ける (UUID の大文字小文字は無視)", async () => {
    const { controller, images, calls } = setup();
    const msg = (event: string, extra: object = {}) => ({
      event,
      action: TAB_ACTION_UUID.toUpperCase(),
      context: "ctx1",
      device: "dev",
      payload: { coordinates: { column: 0, row: 0 }, settings: {}, ...extra },
    });
    await handleMessage(controller, msg("willAppear"), silentLogger);
    assert.match(decode(images.get("ctx1")!), />完了</);
    await handleMessage(controller, msg("didReceiveSettings", { settings: { slot: "3" } }), silentLogger);
    assert.match(decode(images.get("ctx1")!), />確認待ち</);
    await handleMessage(controller, msg("keyDown"), silentLogger);
    await handleMessage(controller, msg("keyUp"), silentLogger);
    assert.deepEqual(calls, ["agent focus w2:p1"]);
    // 別のアクションや壊れたメッセージは無視
    await handleMessage(controller, { event: "keyUp", action: "other.action", context: "ctx1" }, silentLogger);
    await handleMessage(controller, null, silentLogger);
    assert.equal(calls.length, 1);
    await handleMessage(controller, msg("willDisappear"), silentLogger);
    assert.equal(controller.keyCount, 0);
  });

  it("送るメッセージの形", () => {
    const sent: object[] = [];
    const sink = protocolSink((m) => sent.push(m));
    sink.setImage("ctx", "data:image/svg+xml;charset=utf8,<svg/>");
    sink.showAlert("ctx");
    assert.deepEqual(sent, [
      { event: "setImage", context: "ctx", payload: { image: "data:image/svg+xml;charset=utf8,<svg/>", target: 0 } },
      { event: "showAlert", context: "ctx" },
    ]);
  });
});
