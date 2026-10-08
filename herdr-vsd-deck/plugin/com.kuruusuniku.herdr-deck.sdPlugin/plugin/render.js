'use strict';

// キー画像 (144x144 SVG) を作る。VSD Craft の setImage は data:image/svg+xml を受け付けるので
// Canvas 無しで描ける。使う要素は rect / text / circle だけに絞っている (SVG Tiny 相当)。

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

module.exports = { renderAgent, renderEmpty, renderSummary, renderError, fit, formatAge, agentLabels, STYLE, toDataUri };
