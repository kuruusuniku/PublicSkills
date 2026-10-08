'use strict';

// ボタンの画像を SVG で作る。VSD Craft の setImage は data:image/svg+xml を受け付けるので Canvas は要らない。
//
// 座標は 64x64 で組み、実寸は 128x128 にする。VSD M18 のキーは 64x64 ピクセルなので、
// 縮小がちょうど半分になり、ドット絵の 1 マス (2〜3 単位) がにじまない。大きいキーでもベクターなので崩れない。
//
// 配色と見た目は SIOS Tech Lab の記事の仕様に合わせている:
//   背景色で状態を表す: 確認待ち 赤 / 作業中 黄 / 完了 ミント / 待機 青 / エージェントなし 暗い紫
//   選択中のボタン (選んでいるスペースと、herdr でアクティブなタブ) は、背景を状態色の明るい淡い色に、文字を濃い紺に
//   名前は全角4文字がちょうど1行に入る大きさで最大2行。少しはみ出す名前や空白の無い英単語は縮めて1行に
//   文字は白、縁取りではなく右下にずらした薄い影で読みやすくする

const { frameFor, faceFor, toRects, CHAR_W, CHAR_H, FACE_W } = require('./sprites');

const U = 64; // 座標の大きさ
const FONT = `font-family="'Hiragino Sans','Hiragino Kaku Gothic ProN','Yu Gothic UI','Meiryo',sans-serif"`;
const NAVY = '#1e1b4b';

const STATE = {
  blocked: { label: '確認待ち', dark: '#5a1a2e', pale: '#f9b9c8', cell: '#e0446b', ink: '#ffffff' },
  working: { label: '作業中', dark: '#4d3f0e', pale: '#fde68a', cell: '#f2c230', ink: '#2a1f00' },
  done: { label: '完了', dark: '#0f4034', pale: '#b7eedb', cell: '#5fd3ae', ink: '#062a20' },
  idle: { label: '待機', dark: '#1f2852', pale: '#c6d2f3', cell: '#5f7fd0', ink: '#ffffff' },
  none: { label: 'なし', dark: '#231a35', pale: '#ddd3ec', cell: '#3b3152', ink: '#ffffff' },
};

function escapeXml(value) {
  return String(value).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
}

function charWidth(ch) {
  const code = ch.codePointAt(0);
  if (code >= 0x2e80 || (code >= 0x1100 && code <= 0x115f)) return 1;
  if (ch === ' ') return 0.3;
  if (/[A-Z0-9#@%&MWmw]/.test(ch)) return 0.66;
  if (/[il.,:;'|!]/.test(ch)) return 0.3;
  return 0.56;
}

function widthOf(text, size) {
  return Array.from(text).reduce((sum, ch) => sum + charWidth(ch), 0) * size;
}

function ellipsize(text, maxW, size) {
  const chars = Array.from(text);
  while (chars.length && widthOf(`${chars.join('')}…`, size) > maxW) chars.pop();
  return `${chars.join('')}…`;
}

// 2行に折る。空白があれば空白で、無ければ - _ / . の後ろで、それも無ければ文字単位で。2行目に収まらなければ「…」
function wrap2(text, maxW, size) {
  let pieces;
  if (/\s/.test(text)) pieces = text.split(/(\s+)/);
  else if (/[-_/.]./.test(text)) pieces = text.split(/(?<=[-_/.])/);
  else pieces = Array.from(text);
  const lines = [''];
  for (const piece of pieces) {
    const line = lines[lines.length - 1];
    if (widthOf(line + piece, size) <= maxW || !line.trim()) lines[lines.length - 1] = line + piece;
    else lines.push(piece.trimStart());
  }
  const out = lines.map((l) => l.trim()).filter(Boolean);
  if (out.length <= 2) return out.map((l) => (widthOf(l, size) > maxW ? ellipsize(l, maxW, size) : l));
  return [out[0], ellipsize(out.slice(1).join(' '), maxW, size)];
}

// 名前の配置: [{ text, size }] を最大2行で返す
function layoutName(raw, maxW = 60, size = 14) {
  const text = String(raw || '').replace(/\s+/g, ' ').trim() || '-';
  const w = widthOf(text, size);
  if (w <= maxW) return [{ text, size }];
  const singleWord = !/\s/.test(text) && /^[\x21-\x7e]+$/.test(text);
  // 少しはみ出すだけの名前や、空白の無い英単語は、縮めて1行に収める (読める大きさまで)
  const shrunk = Math.floor(((size * maxW) / w) * 10) / 10;
  if ((w <= maxW * 1.3 || singleWord) && shrunk >= 10) return [{ text, size: shrunk }];
  return wrap2(text, maxW, size).map((t) => ({ text: t, size }));
}

function toDataUri(svg) {
  return `data:image/svg+xml;charset=utf8,${encodeURIComponent(svg)}`;
}

function frame(body, bg) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${U * 2}" height="${U * 2}" viewBox="0 0 ${U} ${U}">`
    + `<rect width="${U}" height="${U}" rx="5" fill="${bg}"/>${body}</svg>`;
}

function text(x, y, value, { size, weight = 700, color = '#ffffff', anchor = 'middle', shadow = false }) {
  const attrs = `${FONT} font-size="${size}" font-weight="${weight}" text-anchor="${anchor}"`;
  const shade = shadow ? `<text x="${x + 0.8}" y="${y + 0.8}" ${attrs} fill="#000000" fill-opacity="0.45">${escapeXml(value)}</text>` : '';
  return `${shade}<text x="${x}" y="${y}" ${attrs} fill="${color}">${escapeXml(value)}</text>`;
}

function name(lines, selected) {
  const ys = lines.length === 1 ? [16] : [15, 30];
  return lines.map((l, i) => text(32, ys[i], l.text, { size: l.size, weight: 800, color: selected ? NAVY : '#ffffff', shadow: !selected })).join('');
}

function pixels(rects, ox, oy, scale) {
  return rects.map((r) => `<rect x="${ox + r.x * scale}" y="${oy + r.y * scale}" width="${r.w * scale}" height="${scale}" fill="${r.color}"/>`).join('');
}

function stateOf(status) {
  return STATE[status] || STATE.none;
}

// タブのボタン: 名前 + 住人のキャラクター
function renderTab(tab, { selected = false, tick = 0, animate = true } = {}) {
  if (!tab) return renderEmpty();
  const s = stateOf(tab.status);
  const lines = layoutName(tab.label);
  // 名前が1行ならキャラを大きく (3倍)、2行なら小さく (2倍)。どちらも下揃え
  const scale = lines.length === 1 ? 3 : 2;
  const ox = (U - CHAR_W * scale) / 2;
  const oy = U - 1 - CHAR_H * scale;
  const sprite = pixels(toRects(frameFor(tab.status, animate ? tick : 0)), ox, oy, scale);
  return toDataUri(frame(sprite + name(lines, selected), selected ? s.pale : s.dark));
}

// スペースのボタン: 名前 + そのスペースのタブにいる住人の顔
function renderSpace(space, { selected = false, page = 0, pages = 1, tick = 0 } = {}) {
  if (!space) return renderEmpty();
  const s = stateOf(space.status);
  const lines = layoutName(space.label);
  const residents = space.tabs.filter((t) => t.status !== 'none');
  const showPage = selected && pages > 1;
  const room = showPage ? 3 : 4;
  const shown = residents.length > room ? residents.slice(0, room - 1) : residents;
  const extra = residents.length - shown.length;
  const faceW = FACE_W * 2;
  const totalW = shown.length * faceW + Math.max(0, shown.length - 1) * 2 + (extra ? 14 : 0);
  let x = (showPage ? 46 : U) / 2 - totalW / 2;
  let faces = '';
  for (const tab of shown) {
    faces += pixels(toRects(faceFor(tab.status, tick), FACE_W, 5), x, 50, 2);
    x += faceW + 2;
  }
  if (extra) faces += text(x + 6, 59, `+${extra}`, { size: 9, weight: 800, color: selected ? NAVY : '#ffffff' });
  const pager = showPage ? text(62, 60, `${page + 1}/${pages}`, { size: 9, weight: 800, color: selected ? NAVY : '#ffffff', anchor: 'end' }) : '';
  return toDataUri(frame(name(lines, selected) + faces + pager, selected ? s.pale : s.dark));
}

function renderEmpty() {
  return toDataUri(frame('', '#0d0b14'));
}

// 2x2 のマスに 確認待ち/作業中/完了/待機 の数
function renderSummary(counts, { tick = 0 } = {}) {
  const cells = [['blocked', 1, 1], ['working', 33, 1], ['done', 1, 33], ['idle', 33, 33]];
  const body = cells.map(([status, x, y]) => {
    const n = counts[status] || 0;
    const s = STATE[status];
    const blinkOff = status === 'blocked' && n && tick % 2;
    const fill = n ? (blinkOff ? s.dark : s.cell) : '#1e1b2e';
    return `<rect x="${x}" y="${y}" width="30" height="30" rx="4" fill="${fill}"/>`
      + text(x + 15, y + 22, n > 99 ? '99' : String(n), { size: 18, weight: 800, color: n ? (blinkOff ? '#ffffff' : s.ink) : '#4b4466' });
  }).join('');
  return toDataUri(frame(body, '#0d0b14'));
}

function renderNext(attention, { tick = 0 } = {}) {
  const badge = attention
    ? `<rect x="40" y="3" width="21" height="16" rx="8" fill="${tick % 2 ? STATE.blocked.dark : STATE.blocked.cell}"/>`
      + text(50.5, 15, attention > 9 ? '9+' : String(attention), { size: 11, weight: 800 })
    : '';
  const body = '<path d="M14 18 H32 V10 L50 28 L32 46 V38 H14 Z" fill="#e2e8f0"/>' + badge + text(32, 60, '次へ', { size: 12, weight: 800 });
  return toDataUri(frame(body, '#151226'));
}

function renderMute(muted) {
  const speaker = '<path d="M12 22 H20 L30 13 V43 L20 34 H12 Z" fill="#e2e8f0"/>';
  const icon = muted
    ? '<path d="M37 21 L51 35 M51 21 L37 35" stroke="#fca5a5" stroke-width="4" stroke-linecap="round"/>'
    : '<path d="M36 21 Q41 28 36 35 M42 16 Q50 28 42 40" fill="none" stroke="#e2e8f0" stroke-width="3" stroke-linecap="round"/>';
  return toDataUri(frame(speaker + icon + text(32, 60, muted ? 'ミュート' : '読み上げ', { size: 11, weight: 800 }), muted ? '#7f1d1d' : '#151226'));
}

function renderError(title, detail = '', short = title) {
  const sprite = pixels(toRects(frameFor('idle', 0)), 18, 6, 2);
  const body = sprite + text(32, 46, short, { size: 11, weight: 800, color: '#fecaca' }) + text(32, 59, 'herdr', { size: 8, weight: 700, color: '#94a3b8' });
  return toDataUri(frame(body, '#3f1d1d'));
}

module.exports = {
  renderTab, renderSpace, renderEmpty, renderSummary, renderNext, renderMute, renderError,
  layoutName, widthOf, toDataUri, STATE,
};
