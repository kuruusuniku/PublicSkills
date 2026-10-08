'use strict';

// タブのボタンに住むドット絵のキャラクター (14x12 マス)。状態ごとに演技を変える:
//   working: 机でタイピング (汗をかく)       blocked: 手を振って「!」の吹き出し
//   done:    バンザイして紙吹雪               idle:    居眠り (zzz)
//   none:    エージェントがいないタブは空席 (椅子だけ)
// スペースのボタンには、住人の顔 (6x5 マス) を小さく並べる。

const CHAR_W = 14;
const CHAR_H = 12;
const FACE_W = 6;
const FACE_H = 5;

const COLORS = {
  blocked: { B: '#f2557d', D: '#c93a60' },
  working: { B: '#f7c948', D: '#d9a520' },
  done: { B: '#7fe3c4', D: '#4fbf9d' },
  idle: { B: '#8aa8e0', D: '#6582bf' },
  none: { B: '#6b5a8e', D: '#4d3f6b' },
};

const COMMON = {
  K: '#1b1530', // 輪郭・目
  C: '#ff9fb5', // ほっぺ
  W: '#ffffff', // 吹き出し
  R: '#e11d48', // 「!」
  S: '#7dd3fc', // 汗
  T: '#3d3360', // 机の天板
  F: '#2a2347', // 机の前板
  Z: '#e2e8f0', // zzz
  y: '#fde047', // 紙吹雪
  p: '#f472b6',
  c: '#22d3ee',
  o: '#fb923c',
};

// 体 (2〜10 行目)。E は目、C はほっぺ。
const BODY = [
  '..............',
  '..............',
  '.....KKKK.....',
  '....KBBBBK....',
  '...KBBBBBBK...',
  '...KBEBBEBK...',
  '...KBEBBEBK...',
  '...KCBBBBCK...',
  '...KBBBBBBK...',
  '...KDBBBBDK...',
  '....KKKKKK....',
  '....K....K....',
];

function grid(rows) {
  return rows.map((row) => row.split(''));
}

function put(g, x, y, ch) {
  if (y >= 0 && y < g.length && x >= 0 && x < g[y].length) g[y][x] = ch;
}

function stamp(g, x0, y0, rows) {
  rows.forEach((row, dy) => row.split('').forEach((ch, dx) => { if (ch !== '.') put(g, x0 + dx, y0 + dy, ch); }));
}

function body({ eyes = 'open' } = {}) {
  const g = grid(BODY);
  if (eyes !== 'open') {
    // 閉じた目 / 下を見る目: 目を1行にする
    for (const x of [5, 8]) { put(g, x, 5, 'B'); put(g, x, 6, 'K'); }
    if (eyes === 'closed') { put(g, 4, 6, 'K'); put(g, 9, 6, 'K'); put(g, 4, 5, 'B'); put(g, 9, 5, 'B'); }
  }
  return g;
}

const FRAMES = {
  // 机でタイピング: 手が上下し、汗が落ちる
  working: [0, 1].map((f) => () => {
    const g = body({ eyes: 'down' });
    stamp(g, 0, 9, ['TTTTTTTTTTTTTT', '.FFFFFFFFFFFF.', '.F..........F.']);
    // 手 (体の色) をキーボードの上で交互に上げ下げ
    put(g, 2, f ? 7 : 8, 'B'); put(g, 11, f ? 8 : 7, 'B');
    put(g, 12, f ? 3 : 2, 'S'); put(g, 12, f ? 4 : 3, 'S');
    return g;
  }),
  // 手を振る + 「!」の吹き出し
  blocked: [0, 1].map((f) => () => {
    const g = body();
    if (f) stamp(g, 11, 2, ['..B', '.B.', 'B..']);
    else stamp(g, 11, 2, ['.B.', '.B.', 'B..']);
    stamp(g, 0, 0, ['WWW', 'WRW', 'WRW', 'WWW', 'WRW', '.WW']);
    return g;
  }),
  // バンザイ + 紙吹雪
  done: [0, 1].map((f) => () => {
    const g = body();
    stamp(g, f ? 1 : 2, 1, ['B.', 'B.', '.B']);
    stamp(g, f ? 11 : 10, 1, ['.B', '.B', 'B.']);
    const confetti = f
      ? [[0, 0, 'y'], [4, 0, 'p'], [9, 1, 'c'], [13, 0, 'o'], [0, 6, 'c'], [13, 7, 'p']]
      : [[2, 0, 'c'], [7, 0, 'o'], [12, 1, 'y'], [1, 4, 'p'], [12, 5, 'y'], [0, 9, 'o']];
    for (const [x, y, ch] of confetti) put(g, x, y, ch);
    return g;
  }),
  // 居眠り: 目を閉じて zzz
  idle: [0, 1].map((f) => () => {
    const g = body({ eyes: 'closed' });
    // 「Z」がふわっと上がり、小さな z が出る (体の輪郭には重ねない)
    stamp(g, 11, f ? 0 : 1, ['ZZZ', '..Z', '.Z.', 'ZZZ']);
    if (f) put(g, 9, 1, 'Z');
    return g;
  }),
  // 空席: 椅子だけ
  none: [() => {
    const g = grid(Array.from({ length: CHAR_H }, () => '.'.repeat(CHAR_W)));
    stamp(g, 3, 2, [
      '.KKKKKK.',
      '.KDDDDK.',
      '.KDDDDK.',
      '.KDDDDK.',
      '.KDDDDK.',
      'KKKKKKKK',
      'KBBBBBBK',
      'KKKKKKKK',
      '.K....K.',
      '.K....K.',
    ]);
    return g;
  }],
};

const FACE = ['.KKKK.', 'KBBBBK', 'KEBBEK', 'KBBBBK', '.KKKK.'];

function paint(g, status) {
  const palette = { ...COMMON, ...(COLORS[status] || COLORS.none), E: COMMON.K };
  const pixels = [];
  g.forEach((row, y) => row.forEach((ch, x) => {
    if (ch !== '.' && palette[ch]) pixels.push({ x, y, color: palette[ch] });
  }));
  return pixels;
}

function frameFor(status, tick = 0) {
  const frames = FRAMES[status] || FRAMES.none;
  return paint(frames[Math.abs(tick) % frames.length](), status);
}

// スペースのボタン用の顔。確認待ちは点滅させる。
function faceFor(status, tick = 0) {
  const g = grid(FACE);
  if (status === 'idle') { put(g, 1, 2, 'B'); put(g, 4, 2, 'B'); put(g, 1, 3, 'K'); put(g, 4, 3, 'K'); }
  const pixels = paint(g, status);
  if (status === 'blocked' && tick % 2) return pixels.map((p) => (p.color === COMMON.K ? { ...p, color: COMMON.W } : p));
  return pixels;
}

// 横に連続する同色ピクセルを1つの矩形にまとめる。
function toRects(pixels, width = CHAR_W, height = CHAR_H) {
  const at = new Map();
  for (const p of pixels) if (p.x >= 0 && p.y >= 0 && p.x < width && p.y < height) at.set(`${p.x},${p.y}`, p.color);
  const rects = [];
  for (let y = 0; y < height; y += 1) {
    let x = 0;
    while (x < width) {
      const color = at.get(`${x},${y}`);
      if (!color) { x += 1; continue; }
      let w = 1;
      while (at.get(`${x + w},${y}`) === color) w += 1;
      rects.push({ x, y, w, color });
      x += w;
    }
  }
  return rects;
}

module.exports = { frameFor, faceFor, toRects, FRAMES, CHAR_W, CHAR_H, FACE_W, FACE_H };
