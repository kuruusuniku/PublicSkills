import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ConfigStore, DEFAULT_CONFIG, defaultConfigPath, mergeConfig } from "../src/core/config.ts";

describe("mergeConfig", () => {
  it("何も無ければ既定値 (ずんだもんノーマル=3, Ollama, 1.2秒)", () => {
    const cfg = mergeConfig(undefined);
    assert.deepEqual(cfg, DEFAULT_CONFIG);
    assert.equal(cfg.voice.voicevox.speaker, 3);
    assert.equal(cfg.herdr.pollMs, 1200);
    assert.equal(cfg.llm.baseUrl, "http://127.0.0.1:11434/v1");
  });

  it("一部だけ上書きでき、型違い・未知のキーは警告して捨てる", () => {
    const warnings: string[] = [];
    const logger = { debug() {}, info() {}, error() {}, warn: (m: unknown) => warnings.push(String(m)) };
    const cfg = mergeConfig(
      {
        herdr: { path: "/opt/herdr", pollMs: "fast" },
        voice: { voicevox: { speaker: 1 }, player: ["mpv", "{file}"], announce: ["done", "nope"] },
        llm: { baseUrl: "http://127.0.0.1:1234/v1/", model: "qwen3:8b" },
        typo: true,
      },
      logger,
    );
    assert.equal(cfg.herdr.path, "/opt/herdr");
    assert.equal(cfg.herdr.pollMs, 1200);
    assert.equal(cfg.voice.voicevox.speaker, 1);
    assert.equal(cfg.voice.voicevox.url, DEFAULT_CONFIG.voice.voicevox.url);
    assert.deepEqual(cfg.voice.player, ["mpv", "{file}"]);
    assert.deepEqual(cfg.voice.announce, ["done"]);
    assert.equal(cfg.llm.baseUrl, "http://127.0.0.1:1234/v1");
    assert.equal(cfg.llm.model, "qwen3:8b");
    assert.ok(warnings.some((w) => w.includes("herdr.pollMs")));
    assert.ok(warnings.some((w) => w.includes("typo")));
  });

  it("既定値オブジェクトを書き換えない", () => {
    const cfg = mergeConfig({ deck: { tabs: "agents" } });
    cfg.voice.announce.push("blocked");
    assert.equal(DEFAULT_CONFIG.deck.tabs, "all");
    assert.deepEqual(DEFAULT_CONFIG.voice.announce, ["done", "blocked"]);
  });
});

describe("ConfigStore", () => {
  it("ファイルが無ければ既定値、作れば読み込み、書き換えたら読み直す", () => {
    const dir = mkdtempSync(join(tmpdir(), "herdr-deck-cfg-"));
    try {
      const path = join(dir, "sub", "config.json");
      const store = new ConfigStore(path);
      assert.equal(store.get().llm.model, DEFAULT_CONFIG.llm.model);
      assert.equal(store.ensureFile(), true);
      assert.equal(store.ensureFile(), false);
      assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), DEFAULT_CONFIG);

      writeFileSync(path, JSON.stringify({ llm: { model: "gemma3:12b" } }));
      utimesSync(path, new Date(), new Date(Date.now() + 5000));
      assert.equal(store.get().llm.model, "gemma3:12b");

      writeFileSync(path, "{ broken");
      utimesSync(path, new Date(), new Date(Date.now() + 10000));
      assert.equal(store.get().llm.model, DEFAULT_CONFIG.llm.model);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("既定の置き場所", () => {
    assert.equal(defaultConfigPath({ HERDR_DECK_CONFIG: "/x/c.json" }, "darwin"), "/x/c.json");
    assert.equal(defaultConfigPath({ XDG_CONFIG_HOME: "/xdg" }, "linux"), "/xdg/herdr-deck/config.json");
    assert.equal(defaultConfigPath({ APPDATA: "C:\\Users\\me\\AppData\\Roaming" }, "win32").endsWith("config.json"), true);
  });
});
