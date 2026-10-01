// ボタンに住んでいるドット絵キャラ「まめ」。ずんだ餅をイメージしたオリジナルの枝豆キャラ。
// 1文字 = 1ドット。'.' は透明。

export type Grid = string[];

export const PALETTE: Record<string, string> = {
  K: "#1c2a12", // 輪郭・目
  G: "#a7dd5c", // 体
  L: "#d8f5a2", // ハイライト
  D: "#6fa93a", // 影・芽
  P: "#f49ab2", // ほっぺ
  W: "#ffffff",
  Y: "#ffd23f",
  R: "#e5484d",
  S: "rgba(0,0,0,0.28)", // 足元の影
};

/** エージェントがいないタブ・herdr 未接続のときの灰色版 */
export const GHOST_PALETTE: Record<string, string> = {
  ...PALETTE,
  G: "#9aa3ad",
  L: "#c9cfd6",
  D: "#6b7480",
  P: "#9aa3ad",
};

// 16x16 の体 (目・口は後から描く)
const BODY: Grid = [
  "................",
  ".......DD.......",
  "......DLLD......",
  "........K.......",
  "....KKKKKKKK....",
  "...KLLGGGGGGK...",
  "..KLGGGGGGGGGK..",
  "..KGGGGGGGGGGK..",
  "..KGGGGGGGGGGK..",
  "..KGGGGGGGGGGK..",
  "..KGGGGGGGGGGK..",
  "..KDGGGGGGGGDK..",
  "...KDDGGGGDDK...",
  "....KKKKKKKK....",
  ".....KK..KK.....",
  "................",
];

export type Eyes = "open" | "wide" | "closed" | "happy";
export type Mouth = "flat" | "smile" | "open";
export type Arms = "none" | "down" | "up";

export interface CharacterPose {
  eyes: Eyes;
  mouth: Mouth;
  arms: Arms;
}

type Pixel = [x: number, y: number, c: string];

const EYES: Record<Eyes, Pixel[]> = {
  open: [[5, 7, "K"], [5, 8, "K"], [10, 7, "K"], [10, 8, "K"]],
  wide: [[4, 7, "K"], [5, 7, "W"], [4, 8, "K"], [5, 8, "K"], [10, 7, "K"], [11, 7, "W"], [10, 8, "K"], [11, 8, "K"]],
  closed: [[4, 8, "K"], [5, 8, "K"], [10, 8, "K"], [11, 8, "K"]],
  happy: [[5, 7, "K"], [4, 8, "K"], [6, 8, "K"], [10, 7, "K"], [9, 8, "K"], [11, 8, "K"]],
};

const MOUTH: Record<Mouth, Pixel[]> = {
  flat: [[7, 10, "K"], [8, 10, "K"]],
  smile: [[6, 10, "K"], [9, 10, "K"], [7, 11, "K"], [8, 11, "K"]],
  open: [[7, 10, "K"], [8, 10, "K"], [7, 11, "R"], [8, 11, "R"]],
};

const ARMS: Record<Arms, Pixel[]> = {
  none: [],
  down: [[1, 9, "K"], [1, 10, "K"], [14, 9, "K"], [14, 10, "K"]],
  up: [[1, 5, "K"], [1, 6, "K"], [2, 7, "K"], [14, 5, "K"], [14, 6, "K"], [13, 7, "K"]],
};

function paint(grid: Grid, pixels: Pixel[]): Grid {
  const rows = grid.map((r) => r.split(""));
  for (const [x, y, c] of pixels) {
    if (rows[y] && rows[y][x] !== undefined) rows[y][x] = c;
  }
  return rows.map((r) => r.join(""));
}

export function characterGrid(pose: CharacterPose): Grid {
  return paint(BODY, [[4, 9, "P"], [11, 9, "P"], ...EYES[pose.eyes], ...MOUTH[pose.mouth], ...ARMS[pose.arms]]);
}

// 吹き出し・効果のドット絵
export const ICONS: Record<string, Grid> = {
  exclaim: ["KKKK", "KYYK", "KYYK", "KYYK", "KKKK", "KYYK", "KKKK"],
  question: ["WWW.", "...W", ".WW.", ".W..", "....", ".W.."],
  z: ["WWWW", "..W.", ".W..", "WWWW"],
  dot: ["W"],
  sparkle: ["..Y..", "..Y..", "YYWYY", "..Y..", "..Y.."],
  sparkleSmall: [".Y.", "YWY", ".Y."],
  shadow: ["SSSSSSSS"],
};

export interface Layer {
  grid: Grid;
  x: number;
  y: number;
}

export interface Frame {
  layers: Layer[];
  ghost: boolean;
}

/** キャンバスの大きさ (ドット)。キャラ 16x16 + 周りの効果用の余白 */
export const CANVAS_W = 20;
export const CANVAS_H = 18;

export type SpriteState = "working" | "blocked" | "done" | "idle" | "unknown" | "none" | "offline" | "empty";

function character(pose: CharacterPose, dy: number): Layer[] {
  return [
    { grid: ICONS.shadow, x: 6, y: 17 },
    { grid: characterGrid(pose), x: 2, y: 2 + dy },
  ];
}

/** 状態とフレーム番号 (アニメーションの時刻) からドット絵の重なりを作る */
export function spriteFrame(state: SpriteState, frame: number): Frame {
  const f = ((frame % 12) + 12) % 12;
  switch (state) {
    case "working": {
      // 体を揺らしながら「…」が増えていく
      const i = f % 4;
      const layers = character({ eyes: "open", mouth: "flat", arms: "down" }, i % 2 === 0 ? 0 : -1);
      for (let d = 0; d < i; d++) layers.push({ grid: ICONS.dot, x: 16 + d, y: 7 });
      return { layers, ghost: false };
    }
    case "blocked": {
      // 手を挙げて「！」が点滅
      const i = f % 4;
      const layers = character({ eyes: "wide", mouth: "open", arms: "up" }, i === 1 ? -1 : 0);
      if (i < 2) layers.push({ grid: ICONS.exclaim, x: 16, y: 0 });
      return { layers, ghost: false };
    }
    case "done": {
      // ぴょんぴょん跳ねて、キラキラが入れ替わる
      const i = f % 4;
      const dy = [0, -2, -2, -1][i];
      const layers = character({ eyes: "happy", mouth: "smile", arms: i === 1 || i === 2 ? "up" : "down" }, dy);
      if (i % 2 === 0) {
        layers.push({ grid: ICONS.sparkle, x: 0, y: 0 }, { grid: ICONS.sparkleSmall, x: 17, y: 10 });
      } else {
        layers.push({ grid: ICONS.sparkle, x: 15, y: 0 }, { grid: ICONS.sparkleSmall, x: 0, y: 10 });
      }
      return { layers, ghost: false };
    }
    case "idle": {
      // すやすや。z がゆっくり昇っていく
      const i = Math.floor(f / 2) % 3;
      const layers = character({ eyes: "closed", mouth: "flat", arms: "none" }, 0);
      layers.push({ grid: ICONS.z, x: [15, 16, 16][i], y: [4, 2, 0][i] });
      return { layers, ghost: false };
    }
    case "unknown": {
      const layers = character({ eyes: "open", mouth: "flat", arms: "none" }, 0);
      layers.push({ grid: ICONS.question, x: 16, y: 1 });
      return { layers, ghost: false };
    }
    case "none":
      return { layers: character({ eyes: "closed", mouth: "flat", arms: "none" }, 0), ghost: true };
    case "offline": {
      const layers = character({ eyes: "open", mouth: "flat", arms: "none" }, 0);
      layers.push({ grid: ICONS.question, x: 16, y: 1 });
      return { layers, ghost: true };
    }
    case "empty":
      return { layers: [], ghost: true };
  }
}

/** アニメーションする状態か (しない状態は描き直しを省く) */
export function isAnimated(state: SpriteState): boolean {
  return state === "working" || state === "blocked" || state === "done" || state === "idle";
}

/** キャンバス上の全ドットを [x, y, 色] の配列に平らにする (後ろのレイヤーが上に描かれる) */
export function flatten(frame: Frame): Map<string, string> {
  const palette = frame.ghost ? GHOST_PALETTE : PALETTE;
  const out = new Map<string, string>();
  for (const layer of frame.layers) {
    layer.grid.forEach((row, ry) => {
      for (let rx = 0; rx < row.length; rx++) {
        const c = row[rx];
        if (c === ".") continue;
        const x = layer.x + rx;
        const y = layer.y + ry;
        if (x < 0 || y < 0 || x >= CANVAS_W || y >= CANVAS_H) continue;
        const color = palette[c];
        if (color) out.set(`${x},${y}`, color);
      }
    });
  }
  return out;
}
