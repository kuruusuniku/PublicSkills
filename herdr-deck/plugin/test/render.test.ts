import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";
import { describe, it } from "node:test";
import { escapeXml, fitText, renderKeySvg, svgDataUrl } from "../src/core/render.ts";
import { renderIconPng } from "../src/core/png.ts";
import type { SpriteState } from "../src/core/sprite.ts";
import { CANVAS_H, CANVAS_W, characterGrid, ICONS, PALETTE, spriteFrame } from "../src/core/sprite.ts";
import type { TabView } from "../src/core/types.ts";

const STATES: SpriteState[] = ["working", "blocked", "done", "idle", "unknown", "none", "offline", "empty"];

const view = (over: Partial<TabView> = {}): TabView => ({
  tabId: "w1:t1",
  workspaceId: "w1",
  workspaceLabel: "api",
  tabLabel: "claude",
  multiTab: false,
  state: "working",
  attentionPaneId: "w1:p1",
  agentLabel: "claude",
  agentCount: 1,
  focused: false,
  ...over,
});

describe("ドット絵", () => {
  it("キャラは 16x16、色はすべてパレットにある", () => {
    for (const eyes of ["open", "wide", "closed", "happy"] as const) {
      for (const mouth of ["flat", "smile", "open"] as const) {
        for (const arms of ["none", "down", "up"] as const) {
          const g = characterGrid({ eyes, mouth, arms });
          assert.equal(g.length, 16);
          for (const row of g) {
            assert.equal(row.length, 16);
            for (const c of row) assert.ok(c === "." || c in PALETTE, `unknown color ${c}`);
          }
        }
      }
    }
    for (const [name, g] of Object.entries(ICONS)) {
      const w = g[0].length;
      assert.ok(g.every((r) => r.length === w), `${name} の行の長さがそろっていない`);
    }
  });

  it("どの状態・フレームでも、はみ出さずに描ける", () => {
    for (const state of STATES) {
      for (let f = 0; f < 12; f++) {
        for (const layer of spriteFrame(state, f).layers) {
          const nonEmpty = layer.grid.some((r) => r.replace(/\./g, "") !== "");
          if (!nonEmpty) continue;
          assert.ok(layer.x >= 0 && layer.y >= 0, `${state}/${f}: 負の位置`);
          assert.ok(layer.x + layer.grid[0].length <= CANVAS_W, `${state}/${f}: 右にはみ出し`);
          assert.ok(layer.y + layer.grid.length <= CANVAS_H, `${state}/${f}: 下にはみ出し`);
        }
      }
    }
  });

  it("アニメーションする状態はフレームで絵が変わる", () => {
    for (const state of ["working", "blocked", "done", "idle"] as const) {
      const frames = new Set([0, 1, 2, 3, 4, 5].map((f) => renderKeySvg({ view: view({ state }), frame: f })));
      assert.ok(frames.size > 1, `${state} が動かない`);
    }
    const still = new Set([0, 1, 2, 3].map((f) => renderKeySvg({ view: view({ state: "none" }), frame: f })));
    assert.equal(still.size, 1);
  });
});

describe("renderKeySvg", () => {
  it("状態の文字と色が入った 144x144 の SVG", () => {
    const svg = renderKeySvg({ view: view({ state: "blocked" }), frame: 0 });
    assert.match(svg, /^<svg [^>]*width="144" height="144"/);
    assert.match(svg, />確認待ち<\/text>/);
    assert.match(svg, /fill="#dc2626"/);
    assert.ok(svg.endsWith("</svg>"));
    // 確認待ちは背景が点滅する
    assert.match(renderKeySvg({ view: view({ state: "blocked" }), frame: 2 }), /fill="#9f1239"/);
  });

  it("ラベルは XML エスケープされ、長ければ … で切る", () => {
    const svg = renderKeySvg({ view: view({ workspaceLabel: "<a&b>", multiTab: true, tabLabel: "x".repeat(40) }), frame: 0 });
    assert.match(svg, />&lt;a&amp;b&gt;<\/text>/);
    assert.match(svg, />x+…<\/text>/);
    assert.equal(escapeXml(`"'`), "&quot;&#39;");
    assert.equal(fitText("PublicSkills", 18, 132), "PublicSkills");
    assert.equal(fitText("とても長いワークスペース名", 18, 132), "とても長いワ…");
  });

  it("未接続・空きボタン", () => {
    assert.match(renderKeySvg({ view: null, offline: true, frame: 0 }), /未接続/);
    assert.match(renderKeySvg({ view: null, slot: 5, frame: 0 }), />#5<\/text>/);
  });

  it("data URL", () => {
    const url = svgDataUrl("<svg/>");
    assert.equal(url, `data:image/svg+xml;base64,${Buffer.from("<svg/>").toString("base64")}`);
  });
});

describe("renderIconPng", () => {
  it("正しい PNG (署名・IHDR・展開後のサイズ) を作る", () => {
    for (const size of [20, 56, 144, 512]) {
      const png = renderIconPng({ size, state: "done", background: size > 100 ? "#15803d" : null, monochrome: size < 100 });
      assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      assert.equal(png.readUInt32BE(16), size);
      assert.equal(png.readUInt32BE(20), size);
      // IDAT を展開すると (1 + 幅*4) * 高さ バイト
      const idatLen = png.readUInt32BE(33);
      assert.equal(png.subarray(37, 41).toString("ascii"), "IDAT");
      const raw = inflateSync(png.subarray(41, 41 + idatLen));
      assert.equal(raw.length, (1 + size * 4) * size);
    }
  });
});
