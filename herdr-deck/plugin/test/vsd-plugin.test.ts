import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import type { WebSocket } from "ws";
import { WebSocketServer } from "ws";
import { makeSnapshot } from "./helpers.ts";

// VSD Craft のふりをする WebSocket サーバーに、VSD 用バンドル (CommonJS) を本物と同じ引数でつなぐ。

const root = fileURLToPath(new URL("..", import.meta.url));
const FAKE = join(root, "test", "fixtures", "fake-herdr.mjs");

describe("VSD Craft 用プラグイン (偽 VSD Craft につなぐ)", () => {
  let dir: string;
  let child: ChildProcess;
  let wss: WebSocketServer;
  let socket: WebSocket;
  const received: { event: string; uuid?: string; context?: string; payload?: { image?: string } }[] = [];

  const waitFor = async <T>(what: string, fn: () => T | undefined | false, ms = 8000): Promise<T> => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const v = fn();
      if (v) return v;
      await new Promise((r) => setTimeout(r, 30));
    }
    const log = (() => {
      try {
        return readFileSync(join(dir, "cfg", "vsd-plugin.log"), "utf8");
      } catch {
        return "(no log)";
      }
    })();
    throw new Error(`timeout: ${what}\n--- plugin log ---\n${log}`);
  };
  const lastImage = (ctx: string) =>
    [...received].reverse().find((m) => m.event === "setImage" && m.context === ctx)?.payload?.image;
  const herdrCalls = () => readFileSync(join(dir, "herdr.log"), "utf8");

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "herdr-deck-vsd-"));
    const pluginDir = join(dir, "com.kuruusuniku.herdr-deck.sdPlugin");
    mkdirSync(join(pluginDir, "bin"), { recursive: true });
    mkdirSync(join(dir, "cfg"));
    await esbuild.build({
      entryPoints: [join(root, "src", "vsd.ts")],
      outfile: join(pluginDir, "bin", "plugin.js"),
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node20",
      external: ["bufferutil", "utf-8-validate"],
      logLevel: "silent",
    });
    writeFileSync(join(pluginDir, "bin", "package.json"), '{ "type": "commonjs" }\n');
    writeFileSync(join(dir, "herdr.log"), "");
    writeFileSync(
      join(dir, "state.json"),
      JSON.stringify({
        snapshot: makeSnapshot([{ label: "api", tabs: [{ label: "claude", agents: [{ status: "working" }] }] }]),
        screens: { "w1:p1": "working..." },
      }),
    );
    writeFileSync(join(dir, "cfg", "config.json"), JSON.stringify({ herdr: { path: FAKE, pollMs: 300 }, deck: { frameMs: 150 }, voice: { enabled: false } }));

    wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise((r) => wss.once("listening", r));
    const connected = new Promise<WebSocket>((resolve) =>
      wss.on("connection", (s) => {
        s.on("message", (d) => received.push(JSON.parse(String(d))));
        resolve(s);
      }),
    );
    const info = { application: { language: "ja", platform: "mac", version: "3.10.191.0421" }, devices: [{ id: "dev1", size: { columns: 3, rows: 2 } }] };
    child = spawn(
      process.execPath,
      [join(pluginDir, "bin", "plugin.js"), "-port", String((wss.address() as AddressInfo).port), "-pluginUUID", "VSDPLUGIN", "-registerEvent", "registerPlugin", "-info", JSON.stringify(info)],
      {
        cwd: pluginDir,
        env: { ...process.env, HERDR_DECK_CONFIG: join(dir, "cfg", "config.json"), FAKE_HERDR_STATE: join(dir, "state.json"), FAKE_HERDR_LOG: join(dir, "herdr.log") },
        stdio: "ignore",
      },
    );
    socket = await Promise.race([connected, new Promise<never>((_, rej) => setTimeout(() => rej(new Error("plugin did not connect")), 8000))]);
  });

  after(() => {
    child?.kill();
    wss?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("registerPlugin で登録し、ボタンに生 SVG の画像を送り、押すと herdr のタブへ移動する", async () => {
    const reg = await waitFor("register", () => received.find((m) => m.event === "registerPlugin"));
    assert.equal(reg.uuid, "VSDPLUGIN");

    socket.send(
      JSON.stringify({
        event: "willAppear",
        action: "com.kuruusuniku.herdr-deck.tab",
        context: "k0",
        device: "dev1",
        payload: { coordinates: { column: 0, row: 0 }, settings: {} },
      }),
    );
    const img = await waitFor("作業中の絵", () => lastImage("k0")?.includes(">作業中<") && lastImage("k0"));
    assert.ok(img.startsWith("data:image/svg+xml;charset=utf8,<svg "));
    assert.ok(!img.includes("#"));

    const key = (event: string) =>
      socket.send(JSON.stringify({ event, action: "com.kuruusuniku.herdr-deck.tab", context: "k0", device: "dev1", payload: { settings: {} } }));
    key("keyDown");
    key("keyUp");
    await waitFor("agent focus", () => herdrCalls().includes('["agent","focus","w1:p1"]'));
  });

  it("VSD Craft が接続を切ったら終了する", async () => {
    const exited = new Promise((r) => child.once("exit", r));
    socket.close();
    await Promise.race([exited, new Promise((_, rej) => setTimeout(() => rej(new Error("did not exit")), 5000))]);
  });
});
