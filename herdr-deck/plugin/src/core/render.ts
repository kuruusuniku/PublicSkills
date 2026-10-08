import { STATE_LABEL } from "./model.ts";
import type { SpriteState } from "./sprite.ts";
import { CANVAS_H, CANVAS_W, flatten, spriteFrame } from "./sprite.ts";
import type { TabView } from "./types.ts";

export const KEY_SIZE = 144;

/** 状態ごとのボタンの色。確認待ちは2色で点滅させる */
export const STATE_COLORS: Record<SpriteState, [string, string]> = {
  working: ["#2563eb", "#2563eb"],
  blocked: ["#dc2626", "#9f1239"],
  done: ["#15803d", "#15803d"],
  idle: ["#334155", "#334155"],
  unknown: ["#6d28d9", "#6d28d9"],
  none: ["#1f2937", "#1f2937"],
  offline: ["#3f3f46", "#3f3f46"],
  empty: ["#0b0f14", "#0b0f14"],
};

const FONT = "'Hiragino Sans','Hiragino Kaku Gothic ProN','Yu Gothic UI','Meiryo','Noto Sans CJK JP',sans-serif";

export function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

// 半角 (ASCII・Latin-1・半角カナ) かどうか
const HALF_WIDTH = new RegExp("[\\u0000-\\u00ff\\uff61-\\uff9f]");
const charWidth = (ch: string, fontSize: number) => (HALF_WIDTH.test(ch) ? 0.6 : 1) * fontSize;

/** 全角は 1em、半角は約 0.6em として見積もった文字列の幅 */
export function textWidth(text: string, fontSize: number): number {
  let total = 0;
  for (const ch of text) total += charWidth(ch, fontSize);
  return total;
}

/** 幅に収まらなければ「…」で切る */
export function fitText(text: string, fontSize: number, maxWidth: number): string {
  if (textWidth(text, fontSize) <= maxWidth) return text;
  const width = (ch: string) => charWidth(ch, fontSize);
  const chars = [...text];
  const limit = maxWidth - width("…");
  let used = 0;
  let out = "";
  for (const ch of chars) {
    if (used + width(ch) > limit) break;
    used += width(ch);
    out += ch;
  }
  return out + "…";
}

/**
 * "#rrggbb" を "rgb(r,g,b)" にする。SVG を data URL にそのまま埋め込むとき (VSD Craft)、
 * "#" が URL のフラグメントとして解釈されて途中で切れるのを避けるため、SVG 内では # を使わない。
 */
export function cssColor(color: string): string {
  const m = /^#([0-9a-f]{6})$/i.exec(color);
  if (!m) return color;
  const n = Number.parseInt(m[1], 16);
  return `rgb(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255})`;
}

function textEl(text: string, y: number, size: number): string {
  return (
    `<text x="72" y="${y}" font-family="${FONT}" font-size="${size}" font-weight="700" text-anchor="middle" ` +
    `fill="rgb(255,255,255)" stroke="rgba(0,0,0,0.55)" stroke-width="3" paint-order="stroke" stroke-linejoin="round">` +
    `${escapeXml(text)}</text>`
  );
}

/** ドット絵を SVG の rect 群にする (横に並んだ同じ色はまとめる) */
export function spriteRects(state: SpriteState, frame: number, cell: number, ox: number, oy: number): string {
  const dots = flatten(spriteFrame(state, frame));
  const parts: string[] = [];
  for (let y = 0; y < CANVAS_H; y++) {
    let x = 0;
    while (x < CANVAS_W) {
      const color = dots.get(`${x},${y}`);
      if (!color) {
        x++;
        continue;
      }
      let run = 1;
      while (x + run < CANVAS_W && dots.get(`${x + run},${y}`) === color) run++;
      parts.push(`<rect x="${ox + x * cell}" y="${oy + y * cell}" width="${run * cell}" height="${cell}" fill="${cssColor(color)}"/>`);
      x += run;
    }
  }
  return parts.join("");
}

export interface KeyRenderInput {
  view: TabView | null;
  /** herdr に繋がっていない */
  offline?: boolean;
  /** 割り当てるタブが無いボタンに出す番号 */
  slot?: number;
  frame: number;
}

export function spriteStateFor(input: KeyRenderInput): SpriteState {
  if (input.offline) return "offline";
  if (!input.view) return "empty";
  return input.view.state;
}

/** ボタン1つ分の SVG (144x144) */
export function renderKeySvg(input: KeyRenderInput): string {
  const state = spriteStateFor(input);
  const [c1, c2] = STATE_COLORS[state];
  const bg = input.frame % 4 < 2 ? c1 : c2;
  const view = input.view;

  let top: string[];
  let bottom: string;
  if (input.offline) {
    top = ["herdr"];
    bottom = "未接続";
  } else if (!view) {
    top = [input.slot ? `${input.slot}番` : ""];
    bottom = "空き";
  } else {
    top = view.multiTab ? [view.workspaceLabel, view.tabLabel] : [view.workspaceLabel];
    bottom = view.state === "none" ? "エージェント無し" : STATE_LABEL[view.state];
  }

  const twoLines = top.length > 1;
  const cell = twoLines ? 4 : 5;
  const spriteTop = twoLines ? 44 : 30;
  const ox = (KEY_SIZE - CANVAS_W * cell) / 2;

  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${KEY_SIZE}" height="${KEY_SIZE}" viewBox="0 0 ${KEY_SIZE} ${KEY_SIZE}">`,
    `<rect width="${KEY_SIZE}" height="${KEY_SIZE}" fill="${cssColor(bg)}"/>`,
    `<g shape-rendering="crispEdges">${spriteRects(state, input.frame, cell, ox, spriteTop)}</g>`,
    textEl(fitText(top[0], 18, 132), 22, 18),
  ];
  if (twoLines) parts.push(textEl(fitText(top[1], 15, 132), 40, 15));
  // 下の行は長ければ文字を小さくして収める
  const bottomSize = [18, 16, 14].find((size) => textWidth(bottom, size) <= 136) ?? 14;
  parts.push(textEl(fitText(bottom, bottomSize, 136), 138, bottomSize), "</svg>");
  return parts.join("");
}

export function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}

/**
 * SVG を data URL にそのまま埋め込む (VSD Craft の公式サンプルと同じ形)。
 * 色は rgb() で書いているので、残る # や % はラベル文字だけ。全角に置き換えて URL を壊さないようにする。
 */
export function svgRawDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf8,${svg.replace(/#/g, "＃").replace(/%/g, "％")}`;
}

/** "svg-base64" = Stream Deck 向け / "svg-raw" = VSD Craft 向け */
export type ImageFormat = "svg-base64" | "svg-raw";

export function renderKeyImage(input: KeyRenderInput, format: ImageFormat): string {
  const svg = renderKeySvg(input);
  return format === "svg-raw" ? svgRawDataUrl(svg) : svgDataUrl(svg);
}
