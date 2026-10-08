'use strict';

// キー画像を SVG で作る。VSD Craft の setImage は data:image/svg+xml を受け付けるので
// Canvas 無しで描ける。使う要素は rect / text / path だけに絞っている (SVG Tiny 相当)。
//
// レイアウトは2種類:
//   compact  (既定): 64x64 ピクセルのキー (VSD M18 など) 向け。状態色で塗りつぶし、ドット絵は2倍、文字は1行
//   detailed       : 大きいキー向け。状態名・経過時間・タスク名まで出す (144x144)

const { frameFor, toRects } = require('./sprites');

const SIZE = 144;
const FONT = `font-family="'Hiragino Sans','Hiragino Kaku Gothic ProN','Yu Gothic UI','Meiryo',sans-serif"`;

const STYLE = {
  blocked: { label: '確認待ち', color: '#f59e0b', bg: '#2b1f08', blink: '#fde68a' },
  working: { label: '作業中', color: '#3b82f6', bg: '#0f1d38' },
  done: { label: '完了', color: '#22c55e', bg: '#0c2617' },
  idle: { label: '待機', color: '#64748b', bg: '#151b24' },
  unknown: { label: '不明', color: '#475569', bg: '#151b24' },
};

function escapeXml(value) {
  return String(value).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
}

// 全角は 1em、半角はおおむね 0.6em として幅を見積もり、はみ出す分を「…」で切る。
function charWidth(ch) {
  const code = ch.codePointAt(0);
  if (code >= 0x2e80 || (code >= 0x1100 && code <= 0x115f)) return 1;
  if (ch === ' ') return 0.32;
  if (/[A-Z0-9#@%&MW]/.test(ch)) return 0.66;
  return 0.56;
}

function fit(text, maxPx, fontSize) {
  const chars = Array.from(String(text || '').replace(/\s+/g, ' ').trim());
  const limit = maxPx / fontSize;
  let width = 0;
  for (let i = 0; i < chars.length; i += 1) {
    width += charWidth(chars[i]);
    if (width > limit) {
      let kept = chars.slice(0, i);
      let keptWidth = kept.reduce((sum, c) => sum + charWidth(c), 0);
      while (kept.length && keptWidth + 1 > limit) keptWidth -= charWidth(kept.pop());
      return `${kept.join('')}…`;
    }
  }
  return chars.join('');
}

function formatAge(ms) {
  const min = Math.floor(Math.max(0, ms) / 60000);
  if (min < 1) return '今';
  if (min < 60) return `${min}分`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}時間`;
  return `${Math.floor(h / 24)}日`;
}

function toDataUri(svg) {
  return `data:image/svg+xml;charset=utf8,${encodeURIComponent(svg)}`;
}

function frame(body, { bg, border }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">`
    + `<rect width="${SIZE}" height="${SIZE}" rx="18" fill="${bg}"/>`
    + `<rect x="2" y="2" width="${SIZE - 4}" height="${SIZE - 4}" rx="16" fill="none" stroke="${border}" stroke-width="4"/>`
    + body
    + '</svg>';
}

function text(x, y, value, { size, weight = 700, color = '#f8fafc', anchor = 'middle' }) {
  return `<text x="${x}" y="${y}" ${FONT} font-size="${size}" font-weight="${weight}" fill="${color}" text-anchor="${anchor}">${escapeXml(value)}</text>`;
}

// ドット絵 (24x16 グリッド) を scale 倍で (ox, oy) に置く。
function sprite(status, tick, { ox = 24, oy = 34, scale = 4 } = {}) {
  return toRects(frameFor(status, tick))
    .map((r) => `<rect x="${ox + r.x * scale}" y="${oy + r.y * scale}" width="${r.w * scale}" height="${scale}" fill="${r.color}"/>`)
    .join('');
}

function agentLabels(agent, agents) {
  const sameWorkspace = agents.filter((a) => a.workspaceId === agent.workspaceId).length > 1;
  let main = agent.name || agent.workspace;
  if (!agent.name && sameWorkspace) main = `${agent.workspace} ${agent.tab || agent.paneId.split(':').pop()}`;
  const sub = agent.task || agent.project || agent.kind;
  return { main, sub };
}

function renderAgent(agent, { agents = [agent], since = null, now = Date.now(), tick = 0, animate = true } = {}) {
  const style = STYLE[agent.status] || STYLE.unknown;
  const { main, sub } = agentLabels(agent, agents);
  const blinkOn = agent.status === 'blocked' && tick % 2 === 1;
  const age = since == null ? '' : formatAge(now - since);
  const body = `<rect x="8" y="8" width="128" height="24" rx="8" fill="${style.color}"/>`
    + text(16, 26, style.label, { size: 15, weight: 800, anchor: 'start' })
    + (age ? text(128, 26, age, { size: 13, anchor: 'end' }) : '')
    + sprite(agent.status, animate ? tick : 0)
    + text(72, 116, fit(main, 124, 16), { size: 16, weight: 800 })
    + text(72, 133, fit(sub, 124, 12), { size: 12, weight: 500, color: '#cbd5e1' });
  return toDataUri(frame(body, { bg: style.bg, border: blinkOn ? style.blink : style.color }));
}

function renderEmpty(index) {
  const body = text(72, 66, `#${index + 1}`, { size: 22, weight: 800, color: '#475569' })
    + text(72, 94, '空き', { size: 14, weight: 600, color: '#475569' });
  return toDataUri(frame(body, { bg: '#0b1018', border: '#1e293b' }));
}

function renderSummary(counts, { tick = 0, total = 0 } = {}) {
  const cells = [
    ['blocked', 8, 36], ['working', 74, 36],
    ['done', 8, 88], ['idle', 74, 88],
  ];
  const blinkOn = counts.blocked > 0 && tick % 2 === 1;
  const body = text(72, 26, `herdr  ${total}体`, { size: 15, weight: 800 })
    + cells.map(([status, x, y]) => {
      const s = STYLE[status];
      const n = counts[status] + (status === 'idle' ? counts.unknown : 0);
      return `<rect x="${x}" y="${y}" width="62" height="46" rx="8" fill="${n ? s.color : '#1e293b'}"/>`
        + text(x + 31, y + 17, s.label, { size: 11, weight: 700, color: n ? '#ffffff' : '#64748b' })
        + text(x + 31, y + 40, String(n), { size: 20, weight: 800, color: n ? '#ffffff' : '#64748b' });
    }).join('');
  return toDataUri(frame(body, {
    bg: '#0b1018',
    border: counts.blocked ? (blinkOn ? STYLE.blocked.blink : STYLE.blocked.color) : '#334155',
  }));
}

function renderError(message, detail = '') {
  const body = sprite('idle', 0, { ox: 24, oy: 22 })
    + text(72, 104, fit(message, 128, 15), { size: 15, weight: 800, color: '#e2e8f0' })
    + text(72, 126, fit(detail, 128, 11), { size: 11, weight: 500, color: '#94a3b8' });
  return toDataUri(frame(body, { bg: '#151b24', border: '#7f1d1d' }));
}


// ---------------------------------------------------------------- compact (64x64 キー)
//
// 座標は 64x64 で組み、実寸は 128x128 にする。VSD Craft が SVG を実寸で描いてから 64px に
// 縮めても、ちょうど半分なのでドット絵の1マス (2単位) が 1x1 ピクセルの整数倍に収まる。

const C = 64;
const COMPACT_BG = {
  blocked: ['#b45309', '#ea580c'], // 点滅
  working: ['#1d4ed8'],
  done: ['#15803d'],
  idle: ['#334155'],
  unknown: ['#1f2937'],
};

function compactFrame(body, bg) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${C * 2}" height="${C * 2}" viewBox="0 0 ${C} ${C}">`
    + `<rect width="${C}" height="${C}" fill="${bg}"/>`
    + body
    + '</svg>';
}

function compactAgent(agent, { agents = [agent], since = null, now = Date.now(), tick = 0, animate = true } = {}) {
  const colors = COMPACT_BG[agent.status] || COMPACT_BG.unknown;
  const { main } = agentLabels(agent, agents);
  const age = since == null ? '' : formatAge(now - since);
  const body = (age ? text(62, 9, age, { size: 9, weight: 800, color: '#e2e8f0', anchor: 'end' }) : '')
    + sprite(agent.status, animate ? tick : 0, { ox: 8, oy: 12, scale: 2 })
    + text(32, 59, fit(main, 62, 12), { size: 12, weight: 800 });
  return toDataUri(compactFrame(body, colors[tick % colors.length]));
}

function compactEmpty(index) {
  return toDataUri(compactFrame(text(32, 38, `#${index + 1}`, { size: 14, weight: 800, color: '#475569' }), '#0b1018'));
}

// 2x2 のマスに 確認待ち/作業中/完了/待機 の数だけを大きく出す (文字を入れる余裕は無い)。
function compactSummary(counts, { tick = 0 } = {}) {
  const cells = [['blocked', 1, 1], ['working', 33, 1], ['done', 1, 33], ['idle', 33, 33]];
  const body = cells.map(([status, x, y]) => {
    const n = counts[status] + (status === 'idle' ? counts.unknown : 0);
    const colors = COMPACT_BG[status];
    const fill = n ? colors[tick % colors.length] : '#1e293b';
    return `<rect x="${x}" y="${y}" width="30" height="30" rx="4" fill="${fill}"/>`
      + text(x + 15, y + 22, n > 99 ? '99' : String(n), { size: 18, weight: 800, color: n ? '#ffffff' : '#475569' });
  }).join('');
  return toDataUri(compactFrame(body, '#0b1018'));
}

function compactError(message, detail = '', short = message) {
  const body = sprite('idle', 0, { ox: 8, oy: 2, scale: 2 })
    + text(32, 52, fit(short, 62, 11), { size: 11, weight: 800, color: '#fecaca' })
    + text(32, 62, 'herdr', { size: 8, weight: 700, color: '#94a3b8' });
  return toDataUri(compactFrame(body, '#3f1d1d'));
}

// ---------------------------------------------------------------- ボタン用アクション
// どちらのレイアウトでも同じ絵 (64 座標) を使う。M18 の画面なしボタンに置いた場合は表示されないだけ。

function renderNext(attention, { tick = 0 } = {}) {
  const badge = attention
    ? `<rect x="40" y="3" width="21" height="16" rx="8" fill="${tick % 2 ? '#ea580c' : '#b45309'}"/>`
      + text(50.5, 15, attention > 9 ? '9+' : String(attention), { size: 11, weight: 800 })
    : '';
  const body = '<path d="M14 18 H32 V10 L50 28 L32 46 V38 H14 Z" fill="#e2e8f0"/>'
    + badge
    + text(32, 60, '次へ', { size: 12, weight: 800 });
  return toDataUri(compactFrame(body, '#0f172a'));
}

function renderMute(muted) {
  const speaker = '<path d="M12 22 H20 L30 13 V43 L20 34 H12 Z" fill="#e2e8f0"/>';
  const icon = muted
    ? '<path d="M37 21 L51 35 M51 21 L37 35" stroke="#fca5a5" stroke-width="4" stroke-linecap="round"/>'
    : '<path d="M36 21 Q41 28 36 35 M42 16 Q50 28 42 40" fill="none" stroke="#e2e8f0" stroke-width="3" stroke-linecap="round"/>';
  const body = speaker + icon + text(32, 60, muted ? 'ミュート' : '読み上げ', { size: 11, weight: 800 });
  return toDataUri(compactFrame(body, muted ? '#7f1d1d' : '#0f172a'));
}

const LAYOUTS = {
  compact: { agent: compactAgent, empty: compactEmpty, summary: compactSummary, error: compactError },
  detailed: { agent: renderAgent, empty: renderEmpty, summary: renderSummary, error: renderError },
};

module.exports = {
  LAYOUTS, renderAgent, renderEmpty, renderSummary, renderError, compactAgent, compactEmpty, compactSummary, compactError,
  renderNext, renderMute, fit, formatAge, agentLabels, STYLE, toDataUri,
};
