#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""svg-figures.py — spec(JSON) から図版 SVG を生成する (Python 3 標準ライブラリのみ)

Usage:
  svg-figures.py --spec <spec.json> --index <n> [--palette <name>]
      spec の figures[<n>] (0 始まり) を SVG にして標準出力へ書く

  svg-figures.py --spec <spec.json> --count
      spec を検証し、figures の件数だけを標準出力へ書く (呼び出し側の事前チェック用)

  svg-figures.py --palettes
      利用可能な palette 名を列挙する

出力 viewBox は 1:1 (1200x1200)。compare のみ 3:2 (1800x1200)。

make-images.sh からはモジュールとしても読み込まれる。公開関数:
  load_spec(path)      -> (palette_name, figures)   検証込み。不正なら SpecError
  render(fig, palette) -> SVG 文字列
  build_prompt(fig)    -> codex エンジン用の画像生成プロンプト
"""

import argparse
import json
import os
import sys

# 日本語を含むためフォールバック付きで指定する。
FONT = '"Hiragino Sans","Noto Sans JP","Yu Gothic","Meiryo","Helvetica Neue",sans-serif'
FONT_ATTR = "font-family='" + FONT + "'"

H = 1200            # 高さは共通
W_SQ = 1200         # 1:1
W_WIDE = 1800       # 3:2 (compare)

MIN_LABEL_PX = 32   # viewBox 1200 基準でこれ未満のラベルは作らない

FIGURE_TYPES = ("hero", "flow", "compare", "checklist", "stat")

DEFAULT_PALETTE = "amber-slate"

PALETTES = {
    # ライトで読みやすい配色のみ。dark は Slack モバイルでの縮小表示に弱いので用意しない。
    "amber-slate": {
        "bg0": "#fffaf2", "bg1": "#f0ece4",
        "card0": "#ffffff", "card1": "#fffdf8",
        "ink": "#1f2933", "ink_soft": "#5c6874",
        "accent0": "#f59e0b", "accent1": "#c2740a",
        "accent_soft": "#fdeecd",
        "line": "#e7e0d4",
        "ok0": "#34d399", "ok1": "#0f8a5f",
        "ng": "#a3aab4",
        "shadow": "#6b5a3e",
    },
    "indigo-mist": {
        "bg0": "#f8f9ff", "bg1": "#e9ecfa",
        "card0": "#ffffff", "card1": "#fcfcff",
        "ink": "#1e1b4b", "ink_soft": "#565b8c",
        "accent0": "#6366f1", "accent1": "#4338ca",
        "accent_soft": "#e6e7fd",
        "line": "#e0e2f3",
        "ok0": "#34d399", "ok1": "#0f8a5f",
        "ng": "#9aa0bd",
        "shadow": "#2f3270",
    },
    "teal-sand": {
        "bg0": "#f4fbf9", "bg1": "#faf3e8",
        "card0": "#ffffff", "card1": "#fbfefd",
        "ink": "#123f3a", "ink_soft": "#4c6a66",
        "accent0": "#14b8a6", "accent1": "#0b7268",
        "accent_soft": "#d6f3ee",
        "line": "#dbe9e5",
        "ok0": "#34d399", "ok1": "#0f8a5f",
        "ng": "#98a8a4",
        "shadow": "#0d4a44",
    },
}


class SpecError(Exception):
    """spec JSON が要件を満たしていない。"""


# --------------------------------------------------------------------------
# 文字列ユーティリティ
# --------------------------------------------------------------------------

def esc(s):
    """XML エスケープ。ラベルに & < > " ' が入っても壊れないようにする。"""
    s = "" if s is None else str(s)
    s = s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    return s.replace('"', "&quot;").replace("'", "&#39;")


def _char_w(ch):
    """1 文字の相対幅 (font-size = 1.0 のとき)。実測ではなく経験則の近似。"""
    o = ord(ch)
    if o >= 0x1100 and not (0x2000 <= o <= 0x206F):
        return 1.0                      # CJK / 全角記号はほぼ 1em
    if ch in "iIl|.,:;'!`[]()":
        return 0.31
    if ch in "mwMW@%":
        return 0.92
    if ch.isupper():
        return 0.68
    if ch.isdigit():
        return 0.58
    return 0.54


def text_w(s, size):
    return sum(_char_w(c) for c in s) * size


def _tokens(text, max_px, size):
    """折り返し候補の単位に分解する。CJK は 1 文字ずつ、ラテンは単語ごと。"""
    raw = []
    buf = ""
    for ch in str(text):
        if ch in " \t\n":
            if buf:
                raw.append(buf)
                buf = ""
            raw.append(" ")
        elif ord(ch) >= 0x1100:
            if buf:
                raw.append(buf)
                buf = ""
            raw.append(ch)
        else:
            buf += ch
    if buf:
        raw.append(buf)

    # 1 トークンで行幅を超える長い英単語は文字単位に割る (溢れ防止)
    out = []
    for t in raw:
        if t != " " and text_w(t, size) > max_px:
            out.extend(list(t))
        else:
            out.append(t)
    return out


def wrap(text, max_px, size, max_lines):
    """max_px 幅・max_lines 行に収まるよう折り返す。溢れる場合は末尾を … で省略。"""
    text = "" if text is None else str(text).strip()
    if not text:
        return []
    lines = []
    cur = ""
    for t in _tokens(text, max_px, size):
        if t == " " and not cur:
            continue
        cand = cur + t
        if cur and text_w(cand, size) > max_px:
            lines.append(cur.rstrip())
            cur = "" if t == " " else t
        else:
            cur = cand
    if cur.strip():
        lines.append(cur.rstrip())
    if not lines:
        return []
    if len(lines) > max_lines:
        lines = lines[:max_lines]
        last = lines[-1]
        while last and text_w(last + "…", size) > max_px:
            last = last[:-1]
        lines[-1] = last + "…"
    return lines


def fit_size(text, max_px, start, minimum):
    """1 行で max_px に収まる最大のフォントサイズを返す。"""
    size = start
    while size > minimum and text_w(text, size) > max_px:
        size -= 2
    return size


# --------------------------------------------------------------------------
# SVG 部品
# --------------------------------------------------------------------------

def _t(x, y, s, size, fill, weight="700", anchor="start", opacity=None):
    op = '' if opacity is None else ' opacity="%s"' % opacity
    return ('<text x="%.1f" y="%.1f" %s font-size="%.1f" font-weight="%s" '
            'fill="%s" text-anchor="%s"%s>%s</text>'
            % (x, y, FONT_ATTR, size, weight, fill, anchor, op, esc(s)))


def _block(lines, x, y0, size, lh, fill, weight="700", anchor="start", opacity=None):
    return "\n".join(_t(x, y0 + i * lh, ln, size, fill, weight, anchor, opacity)
                     for i, ln in enumerate(lines))


def _defs(p):
    return '''<defs>
<linearGradient id="gBg" x1="0" y1="0" x2="0.4" y2="1">
<stop offset="0" stop-color="%(bg0)s"/><stop offset="1" stop-color="%(bg1)s"/>
</linearGradient>
<linearGradient id="gAccent" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="%(accent0)s"/><stop offset="1" stop-color="%(accent1)s"/>
</linearGradient>
<linearGradient id="gCard" x1="0" y1="0" x2="0.3" y2="1">
<stop offset="0" stop-color="%(card0)s"/><stop offset="1" stop-color="%(card1)s"/>
</linearGradient>
<linearGradient id="gSoft" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="%(accent_soft)s"/><stop offset="1" stop-color="%(card0)s"/>
</linearGradient>
<linearGradient id="gMuted" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="%(ng)s"/><stop offset="1" stop-color="%(ink_soft)s"/>
</linearGradient>
<linearGradient id="gOk" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="%(ok0)s"/><stop offset="1" stop-color="%(ok1)s"/>
</linearGradient>
<filter id="fCard" x="-25%%" y="-25%%" width="150%%" height="150%%">
<feDropShadow dx="0" dy="14" stdDeviation="20" flood-color="%(shadow)s" flood-opacity="0.15"/>
</filter>
<filter id="fSmall" x="-60%%" y="-60%%" width="220%%" height="220%%">
<feDropShadow dx="0" dy="6" stdDeviation="10" flood-color="%(shadow)s" flood-opacity="0.22"/>
</filter>
</defs>''' % p


def _bg(w, p):
    return "\n".join([
        '<rect x="0" y="0" width="%d" height="%d" fill="url(#gBg)"/>' % (w, H),
        '<circle cx="%d" cy="-80" r="430" fill="url(#gAccent)" opacity="0.13"/>' % (w - 80),
        '<circle cx="-90" cy="%d" r="360" fill="url(#gAccent)" opacity="0.10"/>' % (H + 60),
        '<circle cx="%d" cy="96" r="118" fill="url(#gAccent)" opacity="0.07"/>' % int(w * 0.17),
        '<circle cx="%d" cy="%d" r="70" fill="url(#gAccent)" opacity="0.09"/>' % (int(w * 0.62), H - 70),
    ])


def _card(x, y, w, h, rx, p, fill="url(#gCard)", stroke=None):
    st = ' stroke="%s" stroke-width="2"' % (stroke or p["line"])
    return ('<rect x="%.1f" y="%.1f" width="%.1f" height="%.1f" rx="%.1f" '
            'fill="%s"%s filter="url(#fCard)"/>' % (x, y, w, h, rx, fill, st))


def _check(cx, cy, r, color="#ffffff"):
    return ('<path d="M %.1f %.1f l %.1f %.1f l %.1f %.1f" fill="none" stroke="%s" '
            'stroke-width="%.1f" stroke-linecap="round" stroke-linejoin="round"/>'
            % (cx - 0.40 * r, cy + 0.02 * r, 0.28 * r, 0.30 * r, 0.54 * r, -0.60 * r,
               color, max(4.0, 0.17 * r)))


def _cross(cx, cy, r, color="#ffffff"):
    d = 0.32 * r
    return ('<path d="M %.1f %.1f L %.1f %.1f M %.1f %.1f L %.1f %.1f" fill="none" '
            'stroke="%s" stroke-width="%.1f" stroke-linecap="round"/>'
            % (cx - d, cy - d, cx + d, cy + d, cx + d, cy - d, cx - d, cy + d,
               color, max(4.0, 0.17 * r)))


def _chevron_down(cx, cy, size, color):
    return ('<path d="M %.1f %.1f L %.1f %.1f L %.1f %.1f" fill="none" stroke="%s" '
            'stroke-width="%.1f" stroke-linecap="round" stroke-linejoin="round" opacity="0.75"/>'
            % (cx - size, cy - size * 0.5, cx, cy + size * 0.5, cx + size, cy - size * 0.5,
               color, max(6.0, size * 0.34)))


def _svg(w, body, p):
    return ('<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%d" '
            'viewBox="0 0 %d %d">\n%s\n%s\n%s\n</svg>\n'
            % (w, H, w, H, _defs(p), _bg(w, p), body))


# --------------------------------------------------------------------------
# figure ごとの描画
# --------------------------------------------------------------------------

def _need(fig, key, kind=str):
    v = fig.get(key)
    if kind is str:
        if not isinstance(v, str) or not v.strip():
            raise SpecError("\"%s\" が空か未指定です (空でない文字列が必要)" % key)
        return v.strip()
    if not isinstance(v, list) or not v:
        raise SpecError("\"%s\" が空か未指定です (空でない配列が必要)" % key)
    return v


def fig_hero(fig, p):
    title = _need(fig, "title")
    subtitle = fig.get("subtitle") or ""
    if not isinstance(subtitle, str):
        raise SpecError("hero の \"subtitle\" は文字列で指定してください")

    cx, cw = 108, W_SQ - 216
    pad = 92
    inner = cw - 2 * pad

    tsize = 90
    tl = wrap(title, inner, tsize, 3)
    if len(tl) >= 3:
        tsize = 76
        tl = wrap(title, inner, tsize, 3)
    tlh = tsize * 1.28
    ssize = 42
    sl = wrap(subtitle, inner, ssize, 3)
    slh = ssize * 1.5

    content = 16 + 56 + len(tl) * tlh + (34 + len(sl) * slh if sl else 0) + 44 + 30
    ch = max(660.0, content + 2 * pad)
    cy = max(120.0, (H - ch) / 2)

    b = [_card(cx, cy, cw, ch, 64, p)]
    x = cx + pad
    y = cy + pad
    b.append('<rect x="%.1f" y="%.1f" width="148" height="16" rx="8" fill="url(#gAccent)"/>' % (x, y))
    y += 16 + 56
    b.append(_block(tl, x, y + tsize * 0.80, tsize, tlh, p["ink"], "800"))
    y += len(tl) * tlh
    if sl:
        y += 34
        b.append(_block(sl, x, y + ssize * 0.80, ssize, slh, p["ink_soft"], "500"))
        y += len(sl) * slh
    y += 44
    b.append('<rect x="%.1f" y="%.1f" width="%.1f" height="3" rx="1.5" fill="%s"/>'
             % (x, y, inner, p["line"]))
    for i in range(3):
        b.append('<circle cx="%.1f" cy="%.1f" r="9" fill="url(#gAccent)" opacity="%.2f"/>'
                 % (x + 14 + i * 38, y + 34, 1.0 - i * 0.28))
    return _svg(W_SQ, "\n".join(b), p)


def fig_flow(fig, p):
    steps = _need(fig, "steps", list)
    steps = [str(s) for s in steps]
    if len(steps) > 9:
        raise SpecError("flow の \"steps\" は最大 9 件です (%d 件指定されました)。"
                        "図を分割してください" % len(steps))
    title = fig.get("title") or ""

    top = 108.0
    if title:
        tl = wrap(title, W_SQ - 240, 56, 2)
        top = 96 + len(tl) * 74 + 44
    bottom = 108.0
    n = len(steps)
    gap = 30.0 if n > 4 else 44.0
    avail = H - top - bottom - gap * (n - 1)
    bh = avail / n

    fsize = max(MIN_LABEL_PX, min(52.0, bh * 0.44))
    lines_max = 2 if bh >= fsize * 2.6 else 1

    b = []
    if title:
        b.append(_block(tl, 120, 96 + 56 * 0.8, 56, 74, p["ink"], "800"))
    x, w = 120.0, W_SQ - 240.0
    y = top
    for i, s in enumerate(steps):
        b.append(_card(x, y, w, bh, min(34.0, bh * 0.28), p))
        r = min(52.0, bh * 0.30)
        ncx, ncy = x + 44 + r, y + bh / 2
        b.append('<circle cx="%.1f" cy="%.1f" r="%.1f" fill="url(#gAccent)" filter="url(#fSmall)"/>'
                 % (ncx, ncy, r))
        b.append(_t(ncx, ncy + r * 0.36, str(i + 1), r * 1.02, "#ffffff", "800", "middle"))
        tx = ncx + r + 38
        tw = x + w - 44 - tx
        ls = wrap(s, tw, fsize, lines_max) or [""]
        lh = fsize * 1.28
        ty = ncy - (len(ls) - 1) * lh / 2 + fsize * 0.34
        b.append(_block(ls, tx, ty, fsize, lh, p["ink"], "700"))
        if i < n - 1:
            b.append(_chevron_down(W_SQ / 2, y + bh + gap / 2, min(18.0, gap * 0.36), p["accent1"]))
        y += bh + gap
    return _svg(W_SQ, "\n".join(b), p)


def _compare_side(side, key, p, x, y, w, h, accent):
    if not isinstance(side, dict):
        raise SpecError("compare の \"%s\" はオブジェクト ({label, items}) で指定してください" % key)
    label = side.get("label")
    if not isinstance(label, str) or not label.strip():
        raise SpecError("compare の \"%s\" には空でない \"label\" が必要です" % key)
    items = side.get("items")
    if not isinstance(items, list) or not items:
        raise SpecError("compare の \"%s\" には空でない \"items\" 配列が必要です" % key)
    if len(items) > 6:
        raise SpecError("compare の \"%s.items\" は最大 6 件です (%d 件指定されました)"
                        % (key, len(items)))

    b = [_card(x, y, w, h, 48, p)]
    ph = 108.0
    grad = "url(#gAccent)" if accent else "url(#gMuted)"
    b.append('<rect x="%.1f" y="%.1f" width="%.1f" height="%.1f" rx="%.1f" fill="%s"/>'
             % (x + 34, y + 34, w - 68, ph, ph / 2, grad))
    lsize = fit_size(label, w - 140, 50, MIN_LABEL_PX)
    b.append(_t(x + w / 2, y + 34 + ph / 2 + lsize * 0.35, label, lsize, "#ffffff", "800", "middle"))

    n = len(items)
    top = y + 34 + ph + 40
    avail = y + h - 44 - top
    rh = avail / n
    fsize = max(MIN_LABEL_PX, min(38.0, rh * 0.33))
    for i, it in enumerate(items):
        ry = top + i * rh
        icx = x + 52
        icy = ry + rh / 2
        r = min(22.0, rh * 0.17)
        if accent:
            b.append('<circle cx="%.1f" cy="%.1f" r="%.1f" fill="url(#gOk)"/>' % (icx, icy, r))
            b.append(_check(icx, icy, r))
        else:
            b.append('<circle cx="%.1f" cy="%.1f" r="%.1f" fill="%s" opacity="0.35"/>'
                     % (icx, icy, r, p["ng"]))
            b.append('<rect x="%.1f" y="%.1f" width="%.1f" height="5" rx="2.5" fill="%s"/>'
                     % (icx - r * 0.5, icy - 2.5, r, "#ffffff"))
        tx = icx + r + 26
        tw = x + w - 34 - tx
        ls = wrap(str(it), tw, fsize, 2) or [""]
        lh = fsize * 1.30
        ty = icy - (len(ls) - 1) * lh / 2 + fsize * 0.34
        b.append(_block(ls, tx, ty, fsize, lh,
                        p["ink"] if accent else p["ink_soft"], "600"))
        if i < n - 1:
            b.append('<rect x="%.1f" y="%.1f" width="%.1f" height="2" fill="%s" opacity="0.7"/>'
                     % (x + 44, ry + rh - 1, w - 88, p["line"]))
    return "\n".join(b)


def fig_compare(fig, p):
    if "left" not in fig or "right" not in fig:
        raise SpecError("compare には \"left\" と \"right\" の両方が必要です")
    py, ph = 150.0, 900.0
    pw = 740.0
    b = [
        _compare_side(fig["left"], "left", p, 90, py, pw, ph, False),
        _compare_side(fig["right"], "right", p, W_WIDE - 90 - pw, py, pw, ph, True),
    ]
    ccx, ccy = W_WIDE / 2, py + ph / 2
    b.append('<circle cx="%.1f" cy="%.1f" r="72" fill="%s" filter="url(#fCard)"/>'
             % (ccx, ccy, p["card0"]))
    b.append('<circle cx="%.1f" cy="%.1f" r="72" fill="url(#gSoft)" opacity="0.9"/>' % (ccx, ccy))
    b.append('<path d="M %.1f %.1f h 52 M %.1f %.1f l 22 20 l -22 20" fill="none" '
             'stroke="url(#gAccent)" stroke-width="11" stroke-linecap="round" '
             'stroke-linejoin="round"/>' % (ccx - 28, ccy, ccx + 2, ccy - 20))
    return _svg(W_WIDE, "\n".join(b), p)


def fig_checklist(fig, p):
    items = _need(fig, "items", list)
    if len(items) > 8:
        raise SpecError("checklist の \"items\" は最大 8 件です (%d 件指定されました)" % len(items))
    norm = []
    for it in items:
        if isinstance(it, dict):
            text = it.get("text")
            if not isinstance(text, str) or not text.strip():
                raise SpecError("checklist の各 item には空でない \"text\" が必要です")
            norm.append((text.strip(), bool(it.get("ok", False))))
        elif isinstance(it, str) and it.strip():
            norm.append((it.strip(), True))
        else:
            raise SpecError("checklist の item は {\"text\":..., \"ok\":true|false} で指定してください")

    title = fig.get("title") or ""
    top = 120.0
    b = []
    if title:
        tl = wrap(title, W_SQ - 240, 56, 2)
        b.append(_block(tl, 120, 100 + 56 * 0.8, 56, 74, p["ink"], "800"))
        top = 88 + len(tl) * 74 + 44
    n = len(norm)
    gap = 24.0
    rh = (H - top - 120 - gap * (n - 1)) / n
    fsize = max(MIN_LABEL_PX, min(46.0, rh * 0.42))
    lines_max = 2 if rh >= fsize * 2.5 else 1

    x, w = 116.0, W_SQ - 232.0
    y = top
    for text, ok in norm:
        b.append(_card(x, y, w, rh, min(30.0, rh * 0.30), p,
                       fill="url(#gCard)" if ok else p["card0"]))
        if not ok:
            b.append('<rect x="%.1f" y="%.1f" width="10" height="%.1f" rx="5" fill="%s" opacity="0.5"/>'
                     % (x + 5, y + rh * 0.24, rh * 0.52, p["ng"]))
        r = min(38.0, rh * 0.32)
        icx, icy = x + 48 + r, y + rh / 2
        if ok:
            b.append('<circle cx="%.1f" cy="%.1f" r="%.1f" fill="url(#gOk)" filter="url(#fSmall)"/>'
                     % (icx, icy, r))
            b.append(_check(icx, icy, r))
        else:
            b.append('<circle cx="%.1f" cy="%.1f" r="%.1f" fill="%s" opacity="0.55"/>'
                     % (icx, icy, r, p["ng"]))
            b.append(_cross(icx, icy, r))
        tx = icx + r + 34
        tw = x + w - 48 - tx
        ls = wrap(text, tw, fsize, lines_max) or [""]
        lh = fsize * 1.28
        ty = icy - (len(ls) - 1) * lh / 2 + fsize * 0.34
        b.append(_block(ls, tx, ty, fsize, lh, p["ink"] if ok else p["ink_soft"], "700"))
        y += rh + gap
    return _svg(W_SQ, "\n".join(b), p)


def fig_stat(fig, p):
    value = _need(fig, "value")
    label = _need(fig, "label")
    note = fig.get("note") or ""

    ccx, ccy, r = W_SQ / 2, 520.0, 330.0
    b = [
        '<circle cx="%.1f" cy="%.1f" r="%.1f" fill="url(#gSoft)" filter="url(#fCard)"/>' % (ccx, ccy, r),
        '<circle cx="%.1f" cy="%.1f" r="%.1f" fill="none" stroke="%s" stroke-width="22" opacity="0.5"/>'
        % (ccx, ccy, r + 26, p["accent_soft"]),
    ]
    # 3/4 周のアクセントアーク。A コマンドの large-arc/sweep 指定は中心が跳びやすいので
    # 円 + stroke-dasharray で「上から時計回りに 75%」を確実に描く。
    ring_r = r + 26
    circ = 2 * 3.14159265 * ring_r
    b.append('<circle cx="%.1f" cy="%.1f" r="%.1f" fill="none" stroke="url(#gAccent)" '
             'stroke-width="22" stroke-linecap="round" stroke-dasharray="%.1f %.1f" '
             'transform="rotate(-90 %.1f %.1f)"/>'
             % (ccx, ccy, ring_r, circ * 0.75, circ, ccx, ccy))
    vsize = fit_size(value, r * 1.50, 250.0, 64.0)   # リングに触れないよう余白を残す
    b.append(_t(ccx, ccy + vsize * 0.34, value, vsize, p["ink"], "800", "middle"))

    ll = wrap(label, W_SQ - 240, 54, 2)
    ly = 960.0 - (len(ll) - 1) * 34
    b.append(_block(ll, ccx, ly, 54, 72, p["ink"], "700", "middle"))
    if note:
        nl = wrap(str(note), W_SQ - 260, 36, 2)
        b.append(_block(nl, ccx, ly + len(ll) * 72 + 20, 36, 50, p["ink_soft"], "500", "middle"))
    return _svg(W_SQ, "\n".join(b), p)


RENDERERS = {
    "hero": fig_hero,
    "flow": fig_flow,
    "compare": fig_compare,
    "checklist": fig_checklist,
    "stat": fig_stat,
}


# --------------------------------------------------------------------------
# spec の読み込み / 検証
# --------------------------------------------------------------------------

def validate_figure(fig, i):
    if not isinstance(fig, dict):
        raise SpecError("figures[%d] はオブジェクトである必要があります" % i)
    t = fig.get("type")
    if t not in RENDERERS:
        raise SpecError("figures[%d]: 未知の type %r です。使えるのは %s"
                        % (i, t, " / ".join(FIGURE_TYPES)))
    alt = fig.get("alt")
    if not isinstance(alt, str) or not alt.strip():
        # run-slack-html の絶対要件「すべての img に alt」をここで担保する
        raise SpecError("figures[%d] (type=%s): \"alt\" が空か未指定です。"
                        "すべての figure に画像の内容を説明する alt が必要です" % (i, t))
    # type 固有のフィールド不備 (必須キー欠落・件数超過など) は実際に組み立てて確かめる。
    # 描画は文字列生成だけなので安く、engine が svg でも codex でも同じ基準で弾ける。
    try:
        RENDERERS[t](fig, PALETTES[DEFAULT_PALETTE])
    except SpecError as e:
        raise SpecError("figures[%d] (type=%s): %s" % (i, t, e))
    except Exception as e:  # 想定外の入力でトレースバックを出さない
        raise SpecError("figures[%d] (type=%s): 図版を組み立てられませんでした (%s: %s)"
                        % (i, t, type(e).__name__, e))


def load_spec(path):
    """spec を読み、検証して (palette名, figures) を返す。不正なら SpecError。"""
    if not os.path.isfile(path):
        raise SpecError("spec ファイルが見つかりません: %s" % path)
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except ValueError as e:
        raise SpecError("spec の JSON を解析できません (%s): %s" % (path, e))
    if not isinstance(data, dict):
        raise SpecError("spec のトップレベルはオブジェクトである必要があります: %s" % path)

    palette = data.get("palette") or DEFAULT_PALETTE
    if palette not in PALETTES:
        raise SpecError("未知の palette %r です。使えるのは %s"
                        % (palette, " / ".join(sorted(PALETTES))))

    figures = data.get("figures")
    if not isinstance(figures, list) or len(figures) == 0:
        raise SpecError("\"figures\" は 1 件以上の配列である必要があります")
    for i, fig in enumerate(figures):
        validate_figure(fig, i)
    return palette, figures


def render(fig, palette=DEFAULT_PALETTE):
    if palette not in PALETTES:
        raise SpecError("未知の palette %r です。使えるのは %s"
                        % (palette, " / ".join(sorted(PALETTES))))
    return RENDERERS[fig["type"]](fig, PALETTES[palette])


# --------------------------------------------------------------------------
# codex エンジン用プロンプト
# --------------------------------------------------------------------------

def build_prompt(fig):
    """figure の内容から画像生成プロンプトを組み立てる (codex エンジン用)。"""
    t = fig["type"]
    if t == "hero":
        subject = fig.get("title", "")
        if fig.get("subtitle"):
            subject += " — " + fig["subtitle"]
        body = ("editorial key visual that represents the idea: %s" % subject)
    elif t == "flow":
        body = ("process diagram illustration showing %d sequential stages, "
                "top to bottom, connected by arrows. Stages: %s"
                % (len(fig["steps"]), " -> ".join(str(s) for s in fig["steps"])))
    elif t == "compare":
        left, right = fig["left"], fig["right"]
        body = ("side-by-side before/after comparison. Left (%s): %s. Right (%s): %s"
                % (left.get("label", "Before"), " / ".join(str(i) for i in left.get("items", [])),
                   right.get("label", "After"), " / ".join(str(i) for i in right.get("items", []))))
    elif t == "checklist":
        rows = []
        for it in fig["items"]:
            if isinstance(it, dict):
                rows.append("%s (%s)" % (it.get("text", ""), "done" if it.get("ok") else "not done"))
            else:
                rows.append(str(it))
        body = "checklist illustration with completed and pending rows: " + " / ".join(rows)
    elif t == "stat":
        body = ("single big-number statistic card highlighting %s, meaning: %s"
                % (fig.get("value", ""), fig.get("label", "")))
    else:
        body = str(fig)

    # 縦スクロールで読むモバイル資料に埋め込むので 1:1 (compare のみ 3:2) に揃える。
    aspect = "3:2" if t == "compare" else "1:1"
    return ("A clean, modern flat-vector infographic for a mobile article: %s.\n"
            "Style: soft amber and slate palette on a light background, generous whitespace, "
            "rounded shapes, subtle gradients and soft shadows, no photographic texture.\n"
            "Composition: %s aspect ratio, high quality, readable at small size on a phone "
            "screen, high contrast shapes.\n"
            "Do NOT render paragraphs of text or any Japanese characters; convey the meaning "
            "with shapes, icons and layout only.\n"
            "Reference (context only, do not typeset): %s" % (body, aspect, fig.get("alt", "")))


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------

def main(argv=None):
    ap = argparse.ArgumentParser(
        prog="svg-figures.py",
        description="spec(JSON) の figure を SVG にして標準出力へ書く")
    ap.add_argument("--spec", help="図版仕様 JSON へのパス")
    ap.add_argument("--index", type=int, help="figures の 0 始まりインデックス")
    ap.add_argument("--palette", help="palette 名 (spec の palette を上書きする)")
    ap.add_argument("--count", action="store_true",
                    help="spec を検証し figures の件数だけを出力する")
    ap.add_argument("--palettes", action="store_true",
                    help="利用可能な palette 名を列挙する")
    args = ap.parse_args(argv)

    if args.palettes:
        for name in sorted(PALETTES):
            print(name)
        return 0

    if not args.spec:
        ap.error("--spec は必須です")

    try:
        palette, figures = load_spec(args.spec)
        if args.palette:
            if args.palette not in PALETTES:
                raise SpecError("未知の palette %r です。使えるのは %s"
                                % (args.palette, " / ".join(sorted(PALETTES))))
            palette = args.palette

        if args.count:
            print(len(figures))
            return 0

        if args.index is None:
            ap.error("--index か --count のどちらかを指定してください")
        if args.index < 0 or args.index >= len(figures):
            raise SpecError("--index %d は範囲外です (figures は %d 件、0 始まり)"
                            % (args.index, len(figures)))
        sys.stdout.write(render(figures[args.index], palette))
        return 0
    except SpecError as e:
        sys.stderr.write("svg-figures.py: %s\n" % e)
        return 1


if __name__ == "__main__":
    sys.exit(main())
