import { deflateSync } from "node:zlib";
import type { SpriteState } from "./sprite.ts";
import { CANVAS_H, CANVAS_W, flatten, spriteFrame } from "./sprite.ts";

// アイコン生成用の最小限の PNG エンコーダ (RGBA 8bit, フィルタなし)。外部依存を増やさないため自前で持つ。

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

export function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export function parseColor(color: string): [number, number, number, number] {
  const hex = /^#([0-9a-f]{6})$/i.exec(color);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255];
  }
  const rgba = /^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)$/.exec(color);
  if (rgba) return [+rgba[1], +rgba[2], +rgba[3], Math.round(+rgba[4] * 255)];
  throw new Error(`unknown color ${color}`);
}

export interface IconOptions {
  size: number;
  state: SpriteState;
  frame?: number;
  /** 背景色。null なら透明 */
  background: string | null;
  /** すべてのドットを白にする (Stream Deck のカテゴリ/アクション一覧アイコン用) */
  monochrome?: boolean;
}

/** ドット絵を正方形の PNG にする (ニアレストネイバーで拡大し、中央に置く) */
export function renderIconPng(opts: IconOptions): Buffer {
  const { size } = opts;
  const rgba = new Uint8Array(size * size * 4);
  if (opts.background) {
    const [r, g, b, a] = parseColor(opts.background);
    for (let i = 0; i < size * size; i++) rgba.set([r, g, b, a], i * 4);
  }
  const dots = flatten(spriteFrame(opts.state, opts.frame ?? 0));
  const cell = Math.max(1, Math.floor((size * 0.92) / Math.max(CANVAS_W, CANVAS_H)));
  const ox = Math.floor((size - CANVAS_W * cell) / 2);
  const oy = Math.floor((size - CANVAS_H * cell) / 2);
  for (const [key, color] of dots) {
    const [x, y] = key.split(",").map(Number);
    let [r, g, b, a] = parseColor(color);
    if (opts.monochrome) {
      if (a < 255) continue; // 影は描かない
      [r, g, b] = [255, 255, 255];
    }
    for (let dy = 0; dy < cell; dy++) {
      for (let dx = 0; dx < cell; dx++) {
        const px = ox + x * cell + dx;
        const py = oy + y * cell + dy;
        if (px < 0 || py < 0 || px >= size || py >= size) continue;
        const i = (py * size + px) * 4;
        // 半透明は下地とアルファ合成
        const sa = a / 255;
        const da = rgba[i + 3] / 255;
        const oa = sa + da * (1 - sa);
        if (oa === 0) continue;
        rgba[i] = Math.round((r * sa + rgba[i] * da * (1 - sa)) / oa);
        rgba[i + 1] = Math.round((g * sa + rgba[i + 1] * da * (1 - sa)) / oa);
        rgba[i + 2] = Math.round((b * sa + rgba[i + 2] * da * (1 - sa)) / oa);
        rgba[i + 3] = Math.round(oa * 255);
      }
    }
  }
  return encodePng(size, size, rgba);
}
