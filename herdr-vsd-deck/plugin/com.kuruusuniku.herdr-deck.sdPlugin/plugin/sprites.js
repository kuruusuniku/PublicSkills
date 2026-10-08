'use strict';

// キーに描くドット絵の羊 (herdr = 群れを率いる、にちなんだオリジナルキャラ)。
// 状態ごとに2コマのアニメーションを持つ:
//   working: 走る (脚が交互に動き、汗が飛ぶ)
//   blocked: 頭上の「!」が点滅
//   done:    ぴょんと跳ねてキラキラ
//   idle:    目を閉じて Zzz
//   unknown: 頭上に「?」

const GRID_W = 24;
const GRID_H = 16;

const PALETTE = {
  W: '#f8fafc', // 毛
  w: '#cbd5e1', // 毛の影
  F: '#52525b', // 顔
  L: '#a1a1aa', // 脚
  e: '#ffffff', // 目
  k: '#d4d4d8', // 閉じた目
  p: '#f9a8d4', // ほっぺ
};

// 右向きの羊 (18x10)。脚は別パーツ。
const BODY = [
  '....WW.WW.WW......',
  '..WWWWWWWWWWWWWW..',
  '.WWWWWWWWWWWWFFFF.',
  'WWWWWWWWWWWWFFFFFF',
  'WWWWWWWWWWWWFFFeFF',
  'WWWWWWWWWWWWFFFFFF',
  'WWWWWWWWWWWWFFFFp.',
  '.WWWWWWWWWWWWFFF..',
  '..wWWWWWWWWWWw....',
  '...wwwwwwwwww.....',
];

const LEGS = {
  stand: ['...L..L...L..L....', '...L..L...L..L....'],
  runA: ['..L...L..L...L....', '.L.....L.L.....L..'],
  runB: ['....LL.....LL.....', '....LL.....LL.....'],
  tuck: ['...L.L....L.L.....', '..................'],
};

const EYE_ROW = 4;
const EYE_COL = 15;

const GLYPHS = {
  bang: ['XX', 'XX', 'XX', 'XX', '..', 'XX'],
  question: ['XXX.', '...X', '..X.', '.X..', '....', '.X..'],
  z: ['XXX', '.X.', 'XXX'],
  Z: ['XXXX', '..X.', '.X..', 'XXXX'],
  sparkle: ['.X.', 'XXX', '.X.'],
  drop: ['.X', 'XX', 'XX'],
  dash: ['XXX'],
};

const SHEEP_X = 3;
const SHEEP_Y = 4;

function sheep({ legs = 'stand', eyes = 'open', dx = 0, dy = 0 }) {
  const rows = [...BODY, ...LEGS[legs]].map((row) => row.split(''));
  if (eyes === 'closed') {
    rows[EYE_ROW][EYE_COL] = 'k';
    rows[EYE_ROW][EYE_COL - 1] = 'k';
  }
  const pixels = [];
  rows.forEach((row, y) => row.forEach((ch, x) => {
    if (ch !== '.') pixels.push({ x: SHEEP_X + dx + x, y: SHEEP_Y + dy + y, color: PALETTE[ch] });
  }));
  return pixels;
}

function glyph(name, x, y, color) {
  const pixels = [];
  GLYPHS[name].forEach((row, gy) => row.split('').forEach((ch, gx) => {
    if (ch === 'X') pixels.push({ x: x + gx, y: y + gy, color });
  }));
  return pixels;
}

const FRAMES = {
  working: [
    () => [...glyph('dash', 0, 8, '#93c5fd'), ...glyph('dash', 0, 11, '#93c5fd'), ...sheep({ legs: 'runA' }), ...glyph('drop', 21, 1, '#60a5fa')],
    () => [...glyph('dash', 1, 7, '#93c5fd'), ...glyph('dash', 0, 10, '#93c5fd'), ...sheep({ legs: 'runB', dy: -1 }), ...glyph('drop', 22, 0, '#60a5fa')],
  ],
  blocked: [
    () => [...sheep({}), ...glyph('bang', 21, 0, '#fbbf24')],
    () => [...sheep({ dx: 1 }), ...glyph('bang', 21, 0, '#fef3c7')],
  ],
  done: [
    () => [...sheep({}), ...glyph('sparkle', 0, 2, '#86efac'), ...glyph('sparkle', 21, 5, '#fde047')],
    () => [...sheep({ legs: 'tuck', dy: -3 }), ...glyph('sparkle', 1, 0, '#fde047'), ...glyph('sparkle', 20, 1, '#86efac')],
  ],
  idle: [
    () => [...sheep({ eyes: 'closed' }), ...glyph('z', 20, 2, '#94a3b8')],
    () => [...sheep({ eyes: 'closed' }), ...glyph('Z', 20, 0, '#cbd5e1')],
  ],
  unknown: [
    () => [...sheep({}), ...glyph('question', 20, 0, '#cbd5e1')],
    () => [...sheep({}), ...glyph('question', 20, 0, '#64748b')],
  ],
};

function frameFor(status, tick) {
  const frames = FRAMES[status] || FRAMES.unknown;
  return frames[Math.abs(tick) % frames.length]();
}

// 横に連続する同色ピクセルを1つの <rect> にまとめて SVG を小さくする。
function toRects(pixels) {
  const grid = new Map();
  for (const p of pixels) {
    if (p.x < 0 || p.y < 0 || p.x >= GRID_W || p.y >= GRID_H) continue;
    grid.set(`${p.x},${p.y}`, p.color); // 後から描いたものが上書き
  }
  const rects = [];
  for (let y = 0; y < GRID_H; y += 1) {
    let x = 0;
    while (x < GRID_W) {
      const color = grid.get(`${x},${y}`);
      if (!color) { x += 1; continue; }
      let w = 1;
      while (grid.get(`${x + w},${y}`) === color) w += 1;
      rects.push({ x, y, w, color });
      x += w;
    }
  }
  return rects;
}

module.exports = { frameFor, toRects, GRID_W, GRID_H, FRAMES };
