#!/usr/bin/env python3
"""ReaperAI: Claude Code から REAPER を操作し、MIDI を読み書きするための CLI。

REAPER 側で reaper/ai_bridge.lua を実行しておくと、このスクリプトが
~/ReaperAI/.bridge/ を介してリクエストを送り、結果を受け取る。

  reaper_ai.py status                 ブリッジが動いているか確認
  reaper_ai.py project                プロジェクトの概要 (トラック・小節・マーカー)
  reaper_ai.py read --track Piano     MIDI を読んで、調・コード推定つきのテキストで表示
  reaper_ai.py write part.json        JSON の MIDI を新しいトラック/アイテムに書き込む
  reaper_ai.py view song.mid          REAPER なしで .mid / .json を同じ形式で表示
  reaper_ai.py play --bar 9           9 小節目から再生

標準ライブラリだけで動く (Python 3.9 以上)。
"""
from __future__ import annotations

import argparse
import json
import os
import random
import re
import struct
import sys
import time
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

BASE_DIR = Path(os.environ.get("REAPER_AI_DIR", "~/ReaperAI")).expanduser()
# macOS の App Nap で裏に回った REAPER のタイマーが間引かれることがあるので余裕を持たせる
HEARTBEAT_MAX_AGE = 15.0  # 秒

EXIT_OK, EXIT_OP_ERROR, EXIT_USAGE, EXIT_NO_BRIDGE = 0, 1, 2, 3


class BridgeError(Exception):
    def __init__(self, message: str, code: int = EXIT_OP_ERROR):
        super().__init__(message)
        self.code = code


# ---------------------------------------------------------------------------
# ブリッジとの通信
# ---------------------------------------------------------------------------

def bridge_dirs(base: Path = None) -> Dict[str, Path]:
    base = base or BASE_DIR
    bridge = base / ".bridge"
    return {"inbox": bridge / "inbox", "outbox": bridge / "outbox", "heartbeat": bridge / "heartbeat.json"}


NOT_RUNNING_HELP = (
    "REAPER のブリッジが動いていません。\n"
    "REAPER で Actions → Show action list を開き、'ai_bridge.lua' を実行してください。\n"
    "(初回は New action → Load ReaScript... で reaper/ai_bridge.lua を読み込みます)"
)


def heartbeat_age(base: Path = None) -> Optional[float]:
    hb = bridge_dirs(base)["heartbeat"]
    try:
        data = json.loads(hb.read_text(encoding="utf-8"))
        return time.time() - float(data["time"])
    except (OSError, ValueError, KeyError, TypeError):
        return None


def call(op: str, args: Optional[dict] = None, timeout: float = 20.0, base: Path = None) -> Any:
    """ブリッジに op を送り、result を返す。失敗したら BridgeError。"""
    dirs = bridge_dirs(base)
    age = heartbeat_age(base)
    if age is None or age > HEARTBEAT_MAX_AGE:
        raise BridgeError(NOT_RUNNING_HELP, EXIT_NO_BRIDGE)

    req_id = "%d-%d-%06d" % (int(time.time() * 1000), os.getpid(), random.randint(0, 999999))
    request = {"op": op, "args": args or {}, "created": int(time.time())}
    dirs["inbox"].mkdir(parents=True, exist_ok=True)
    tmp = dirs["inbox"] / (req_id + ".json.tmp")
    req_path = dirs["inbox"] / (req_id + ".json")
    tmp.write_text(json.dumps(request, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, req_path)

    resp_path = dirs["outbox"] / (req_id + ".json")
    deadline = time.time() + timeout
    while time.time() < deadline:
        if resp_path.exists():
            try:
                resp = json.loads(resp_path.read_text(encoding="utf-8"))
            except ValueError:
                time.sleep(0.02)  # 書きかけ
                continue
            resp_path.unlink()
            if resp.get("ok"):
                return resp.get("result")
            raise BridgeError(str(resp.get("error", "不明なエラー")))
        time.sleep(0.03)

    # 取り残されたリクエストが後で実行されないように消す
    try:
        req_path.unlink()
    except FileNotFoundError:
        raise BridgeError("REAPER が処理中のまま %.0f 秒経ちました。REAPER の画面を確認してください" % timeout, EXIT_NO_BRIDGE)
    raise BridgeError("REAPER から %.0f 秒以内に応答がありませんでした。\n%s" % (timeout, NOT_RUNNING_HELP), EXIT_NO_BRIDGE)


# ---------------------------------------------------------------------------
# 音名
# ---------------------------------------------------------------------------

SHARP_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
FLAT_NAMES = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"]
LETTER_PC = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}

# GM ドラム (ch 10) の名前 → ノート番号
GM_DRUMS = {
    "kick": 36, "bd": 36, "kick2": 35, "rim": 37, "sidestick": 37, "snare": 38, "sd": 38,
    "clap": 39, "snare2": 40, "floor_tom": 41, "low_floor_tom": 41, "closed_hh": 42, "chh": 42,
    "high_floor_tom": 43, "pedal_hh": 44, "low_tom": 45, "open_hh": 46, "ohh": 46,
    "low_mid_tom": 47, "mid_tom": 47, "high_mid_tom": 48, "crash": 49, "high_tom": 50,
    "ride": 51, "china": 52, "ride_bell": 53, "tambourine": 54, "splash": 55, "cowbell": 56,
    "crash2": 57, "ride2": 59, "shaker": 70, "maracas": 70, "high_conga": 62, "low_conga": 64,
    "claves": 75, "high_wood": 76, "low_wood": 77, "triangle": 81, "open_triangle": 81,
}

_PITCH_RE = re.compile(r"^\s*([A-Ga-g])([#b♯♭]*)(-?\d+)\s*$")


def parse_pitch(v: Any) -> int:
    """60 / "C4" / "Bb2" / "F#3" / "kick" → MIDI ノート番号 (C4 = 60)。"""
    if isinstance(v, bool):
        raise ValueError("pitch に真偽値は使えません")
    if isinstance(v, int):
        p = v
    elif isinstance(v, float) and v.is_integer():
        p = int(v)
    elif isinstance(v, str):
        key = v.strip().lower().replace(" ", "_")
        if key in GM_DRUMS:
            return GM_DRUMS[key]
        m = _PITCH_RE.match(v)
        if not m:
            raise ValueError("音名を解釈できません: %r (例: C4, Bb2, F#3)" % v)
        letter, acc, octave = m.groups()
        pc = LETTER_PC[letter.upper()]
        pc += acc.count("#") + acc.count("♯") - acc.count("b") - acc.count("♭")
        p = (int(octave) + 1) * 12 + pc
    else:
        raise ValueError("pitch が不正です: %r" % (v,))
    if not 0 <= p <= 127:
        raise ValueError("pitch が範囲外です (0-127): %r" % (v,))
    return p


def pitch_name(p: int, flats: bool = False) -> str:
    names = FLAT_NAMES if flats else SHARP_NAMES
    return "%s%d" % (names[p % 12], p // 12 - 1)


def pc_name(pc: int, flats: bool = False) -> str:
    return (FLAT_NAMES if flats else SHARP_NAMES)[pc % 12]


# ---------------------------------------------------------------------------
# 調とコードの推定
# ---------------------------------------------------------------------------

MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]
FLAT_MAJOR_KEYS = {5, 10, 3, 8, 1, 6}   # F Bb Eb Ab Db Gb
FLAT_MINOR_KEYS = {2, 7, 0, 5, 10, 3}   # Dm Gm Cm Fm Bbm Ebm


def _pearson(a: Sequence[float], b: Sequence[float]) -> float:
    n = len(a)
    ma, mb = sum(a) / n, sum(b) / n
    num = sum((x - ma) * (y - mb) for x, y in zip(a, b))
    da = sum((x - ma) ** 2 for x in a) ** 0.5
    db = sum((y - mb) ** 2 for y in b) ** 0.5
    return num / (da * db) if da and db else 0.0


def estimate_key(hist: Sequence[float]) -> List[Tuple[float, int, str]]:
    """音高クラスの重み (12) から調の候補を相関の高い順に返す: (score, tonic_pc, 'major'|'minor')。"""
    if sum(hist) <= 0:
        return []
    out = []
    for tonic in range(12):
        rotated = [hist[(tonic + i) % 12] for i in range(12)]
        out.append((_pearson(rotated, MAJOR_PROFILE), tonic, "major"))
        out.append((_pearson(rotated, MINOR_PROFILE), tonic, "minor"))
    out.sort(reverse=True)
    return out


def key_uses_flats(tonic: int, mode: str) -> bool:
    return tonic in (FLAT_MAJOR_KEYS if mode == "major" else FLAT_MINOR_KEYS)


def key_label(tonic: int, mode: str) -> str:
    return "%s %s" % (pc_name(tonic, key_uses_flats(tonic, mode)), mode)


# (表記, 基本の 3 音, テンション)。テンションは十分鳴っているときだけ名前に付ける
CHORD_TYPES = [
    ("", (0, 4, 7), ()), ("m", (0, 3, 7), ()), ("dim", (0, 3, 6), ()), ("aug", (0, 4, 8), ()),
    ("sus4", (0, 5, 7), ()), ("sus2", (0, 2, 7), ()),
    ("7", (0, 4, 7), (10,)), ("maj7", (0, 4, 7), (11,)), ("m7", (0, 3, 7), (10,)), ("mM7", (0, 3, 7), (11,)),
    ("m7b5", (0, 3, 6), (10,)), ("dim7", (0, 3, 6), (9,)), ("6", (0, 4, 7), (9,)), ("m6", (0, 3, 7), (9,)),
    ("7sus4", (0, 5, 7), (10,)), ("add9", (0, 4, 7), (2,)), ("madd9", (0, 3, 7), (2,)),
    ("9", (0, 4, 7), (10, 2)), ("maj9", (0, 4, 7), (11, 2)), ("m9", (0, 3, 7), (10, 2)),
    ("7b9", (0, 4, 7), (10, 1)), ("7#9", (0, 4, 7), (10, 3)), ("m11", (0, 3, 7), (10, 5)),
    ("6/9", (0, 4, 7), (9, 2)), ("13", (0, 4, 7), (10, 9)),
]
CORE_MIN, TENSION_MIN = 0.02, 0.12


def match_chord(weights: Sequence[float], bass_pc: Optional[int]) -> Optional[Tuple[float, int, str]]:
    """12 音高クラスの重みから最もそれらしいコードを返す: (当てはまりの良さ, root_pc, 表記の接尾辞)。"""
    total = sum(weights)
    if total <= 0:
        return None
    w = [x / total for x in weights]
    if sum(1 for x in w if x > 0.04) < 2:
        return None
    best = None
    for root in range(12):
        if w[root] < CORE_MIN:
            continue
        for suffix, core, tensions in CHORD_TYPES:
            tones = {(root + i) % 12 for i in core + tensions}
            covered = sum(w[t] for t in tones)
            score = covered - 0.8 * (1 - covered) - 0.03 * len(tensions)
            for i in core[1:]:
                if w[(root + i) % 12] < CORE_MIN:
                    score -= 0.04 if i == 7 else 0.12  # 完全5度の省略は軽く
            for i in tensions:
                if w[(root + i) % 12] < TENSION_MIN:
                    score -= 0.2
                elif w[(root + i) % 12] > 1.5 * w[root]:
                    score -= 0.1  # 根音よりずっと強く鳴っている音はテンションらしくない
            if bass_pc == root:
                score += 0.12
            if best is None or score > best[0]:
                best = (score, root, suffix)
    return best


CORE_OF = {suffix: core for suffix, core, _ in CHORD_TYPES}


def chord_symbol(root: int, suffix: str, bass_pc: Optional[int], flats: bool) -> str:
    s = pc_name(root, flats) + suffix
    if bass_pc is not None and bass_pc != root:
        s += "/" + pc_name(bass_pc, flats)
    return s


def pedal_intervals(ccs: Iterable[dict]) -> Dict[int, List[Tuple[float, float]]]:
    """CC64 (サステインペダル) の踏んでいる区間をチャンネルごとに返す。"""
    events: Dict[int, List[Tuple[float, bool]]] = {}
    for c in ccs:
        if c.get("type", "cc") == "cc" and c.get("cc") == 64:
            events.setdefault(c.get("ch", 1), []).append((float(c["start"]), c.get("val", 0) >= 64))
    out: Dict[int, List[Tuple[float, float]]] = {}
    for ch, evs in events.items():
        evs.sort()
        down_at = None
        spans = []
        for t, down in evs:
            if down and down_at is None:
                down_at = t
            elif not down and down_at is not None:
                spans.append((down_at, t))
                down_at = None
        if down_at is not None:
            spans.append((down_at, float("inf")))
        out[ch] = spans
    return out


PEDAL_WEIGHT = 0.25  # ペダルで残っているだけの音は減衰しているので軽く数える
MELODY_WEIGHT = 0.5  # 上声部の短い音 (旋律) の重み


def sounding_notes(notes: Sequence[dict], ccs: Sequence[dict]) -> List[Tuple[float, float, float, int, float]]:
    """(start, 鍵盤を離した位置, ペダルで伸びた終わり, pitch, 重み)。

    一番上の声部にある四分音符以下の音は旋律 (経過音・刺繍音) とみなし、和音の判定では軽く数える。
    """
    pedals = pedal_intervals(ccs)
    ordered = sorted(notes, key=lambda n: float(n["start"]))
    out = []
    active: List[Tuple[float, int]] = []  # (end, pitch)
    for n in ordered:
        s = float(n["start"])
        e = s + float(n["len"])
        p = int(n["pitch"])
        held = e
        for ps, pe in pedals.get(n.get("ch", 1), ()):
            if ps <= e < pe and pe != float("inf"):
                held = max(held, pe)
        active = [(ae, ap) for ae, ap in active if ae > s + 1e-6]
        is_top = all(ap < p for _, ap in active)
        weight = MELODY_WEIGHT if is_top and active and e - s <= 1.0 + 1e-6 else 1.0
        active.append((e, p))
        out.append((s, e, held, p, weight))
    return out


def segment_weights(snd: Sequence[Tuple[float, float, float, int, float]], ws: float, we: float) -> Tuple[List[float], Optional[int], List[float]]:
    """区間の音高クラスの重み、ベース音 (区間の 2 割以上弾かれている一番低い音)、ベース音を除いた重み。"""
    weights = [0.0] * 12
    by_pitch: Dict[int, float] = {}
    played_by_pitch: Dict[int, float] = {}
    for s, e, held, p, nw in snd:
        played = max(min(e, we) - max(s, ws), 0.0)
        sustained = max(min(held, we) - max(e, ws), 0.0)
        w = nw * (played + PEDAL_WEIGHT * sustained)
        if w <= 1e-6:
            continue
        weights[p % 12] += w
        by_pitch[p] = by_pitch.get(p, 0.0) + w
        if played > 1e-6:
            played_by_pitch[p] = played_by_pitch.get(p, 0.0) + played
    if not played_by_pitch:
        return weights, None, weights
    solid = [p for p, w in played_by_pitch.items() if w >= 0.2 * (we - ws)]
    bass = min(solid) if solid else min(played_by_pitch)
    upper = list(weights)
    upper[bass % 12] -= by_pitch[bass]
    return weights, bass, upper


def beat_windows(bar: dict) -> List[Tuple[float, float, float]]:
    """小節を拍で区切る: (start_qn, end_qn, 拍番号)。6/8 などは付点四分で区切る。"""
    num, denom = int(bar["num"]), int(bar["denom"])
    beat_len = 4.0 / denom
    step = 3 if denom == 8 and num % 3 == 0 and num >= 6 else 1
    out = []
    i = 0
    while i < num:
        s = bar["start"] + i * beat_len
        e = min(bar["end"], s + step * beat_len)
        out.append((s, e, 1 + i))
        i += step
    return out


SPLIT_MARGIN = 0.1


def _fit(snd, ws, we, flats):
    """区間のコード: (当てはまり, 表記, 同一視のキー)。表記 None は判定できない (単音など)。

    同一視のキーは (根音, 基本の 3 和音, ベース)。テンションの有無だけの違いでは区間を分けない。
    """
    weights, bass, upper = segment_weights(snd, ws, we)
    if sum(weights) <= 0:
        return 1.0, "N.C.", "N.C."
    bass_pc = bass % 12 if bass is not None else None
    m = match_chord(weights, bass_pc)
    if m is None:
        return 0.0, None, None
    score, root, suffix = m
    # 転回形になったとき、ベースの音が上の声部にほとんどないなら上の声部だけで読む (C6/G より Am/G)
    if bass_pc is not None and root != bass_pc and upper[bass_pc] <= 0.08 * sum(weights):
        mu = match_chord(upper, None)
        if mu is not None:
            _, root, suffix = mu
    return score, chord_symbol(root, suffix, bass_pc, flats), (root, CORE_OF[suffix], bass_pc)


def _segment(snd, ws, we, points, flats, depth):
    """区間を拍の位置で分けたほうが明らかに当てはまるなら分ける。([(start, 表記, キー)], 当てはまり)。"""
    whole_score, whole_sym, whole_key = _fit(snd, ws, we, flats)
    best = ([(ws, whole_sym, whole_key)], whole_score)
    if depth <= 0:
        return best
    for p in points:
        if not ws < p < we:
            continue
        left, ls = _segment(snd, ws, p, points, flats, depth - 1)
        right, rs = _segment(snd, p, we, points, flats, depth - 1)
        if left[-1][2] == right[0][2]:
            continue
        combined = (ls * (p - ws) + rs * (we - p)) / (we - ws)
        if combined > best[1] + SPLIT_MARGIN:
            best = (left + right, combined)
    return best


def analyze_chords(notes: Sequence[dict], ccs: Sequence[dict], bars: Sequence[dict], flats: bool) -> Dict[int, List[Tuple[float, str]]]:
    """小節ごとのコード推定: {bar: [(拍, 表記), ...]}。"""
    snd = sounding_notes(notes, ccs)
    onsets = sorted({float(n["start"]) for n in notes})
    result: Dict[int, List[Tuple[float, str]]] = {}
    prev: Optional[str] = None
    for bar in bars:
        windows = beat_windows(bar)
        beat_of = {round(ws, 6): beat for ws, _, beat in windows}
        # 音の出だしがある拍の頭だけを分割の候補にする
        points = [ws for ws, _, _ in windows[1:] if any(abs(o - ws) <= 0.06 for o in onsets)]
        segs, _ = _segment(snd, bar["start"], bar["end"], points, flats, 2)
        changes: List[Tuple[float, str]] = []
        for start, sym, _ in segs:
            if sym is None:
                continue
            if sym != prev or not changes:
                if not changes or changes[-1][1] != sym:
                    changes.append((beat_of.get(round(start, 6), 1), sym))
            prev = sym
        if not changes and prev:
            changes.append((1, prev))  # 前の小節のコードが続いている
        result[bar["bar"]] = changes
    return result


# ---------------------------------------------------------------------------
# テキスト表示
# ---------------------------------------------------------------------------

def fmt_num(x: float, digits: int = 3) -> str:
    s = ("%." + str(digits) + "f") % x
    return s.rstrip("0").rstrip(".") if "." in s else s


def fmt_beat(b: float) -> str:
    return fmt_num(b, 2)


def item_histogram(notes: Sequence[dict]) -> List[float]:
    hist = [0.0] * 12
    for n in notes:
        hist[int(n["pitch"]) % 12] += float(n["len"])
    return hist


def render_item(item: dict, detail: bool = True, onset_tolerance: float = 0.06) -> str:
    notes = sorted(item.get("notes", []), key=lambda n: (n["start"], n["pitch"]))
    ccs = item.get("cc", [])
    bars = item.get("bars") or []
    lines = []
    ts = item.get("timesig") or [4, 4]
    head = "## %s" % (item.get("track") or "(no name)")
    if item.get("take_name"):
        head += " / %s" % item["take_name"]
    head += "  bars %s-%s  %s/%s" % (item.get("start_bar", "?"), item.get("end_bar", "?"), ts[0], ts[1])
    if item.get("tempo"):
        head += "  %s BPM" % fmt_num(item["tempo"], 2)
    head += "  notes %d" % len(notes)
    pedal = [c for c in ccs if c.get("type", "cc") == "cc" and c.get("cc") == 64]
    if pedal:
        head += "  pedal(CC64) %d" % len(pedal)
    if item.get("item"):
        head += "\nitem: %s" % item["item"]
    if item.get("muted"):
        head += "  (muted)"
    lines.append(head)
    if not notes:
        lines.append("(ノートなし)")
        return "\n".join(lines)

    keys = estimate_key(item_histogram(notes))
    flats = key_uses_flats(keys[0][1], keys[0][2]) if keys else False
    if keys:
        lines.append("key (推定): " + " | ".join("%s %.2f" % (key_label(t, m), s) for s, t, m in keys[:3]))
    pitches = [int(n["pitch"]) for n in notes]
    vels = [int(n.get("vel", 0)) for n in notes]
    lines.append("range: %s-%s   velocity: %d-%d (avg %d)   ※C4=60 (Cubase表記ではC3)" % (
        pitch_name(min(pitches), flats), pitch_name(max(pitches), flats), min(vels), max(vels), round(sum(vels) / len(vels))))
    programs = [c for c in ccs if c.get("type") == "pc"]
    if programs:
        lines.append("program change: " + ", ".join("ch%d=%d" % (c.get("ch", 1), c["val"]) for c in programs[:8]))

    chords = analyze_chords(notes, ccs, bars, flats) if bars else {}
    if chords:
        lines.append("")
        lines.append("chords (推定, 拍頭):")
        row = []
        for bar in bars:
            ch = chords.get(bar["bar"], [])
            cell = " ".join(sym if beat == 1 else "%s@%s" % (sym, fmt_beat(beat)) for beat, sym in ch) or "-"
            row.append("%d| %s" % (bar["bar"], cell))
            if len(row) == 4:
                lines.append("  " + "   ".join(row))
                row = []
        if row:
            lines.append("  " + "   ".join(row))

    if not detail:
        return "\n".join(lines)

    by_bar: Dict[int, List[dict]] = {}
    for n in notes:
        by_bar.setdefault(int(n["bar"]), []).append(n)
    pedal_by_bar: Dict[int, List[str]] = {}
    for c in pedal:
        pedal_by_bar.setdefault(int(c["bar"]), []).append(("v" if c.get("val", 0) >= 64 else "^") + fmt_beat(c["beat"]))

    for bar_no in sorted(set(by_bar) | set(pedal_by_bar)):
        lines.append("")
        head = "bar %d" % bar_no
        if chords.get(bar_no):
            head += "  [" + " -> ".join(sym for _, sym in chords[bar_no]) + "]"
        if pedal_by_bar.get(bar_no):
            head += "  pedal " + " ".join(pedal_by_bar[bar_no])
        lines.append(head)
        group: List[dict] = []
        for n in by_bar.get(bar_no, []) + [None]:
            if n is not None and group and n["start"] - group[0]["start"] <= onset_tolerance:
                group.append(n)
                continue
            if group:
                group.sort(key=lambda x: x["pitch"])
                notes_s = " ".join("%s(%s)" % (pitch_name(int(g["pitch"]), flats), fmt_num(g["len"])) for g in group)
                vs = [int(g.get("vel", 0)) for g in group]
                vel_s = "v%d" % vs[0] if min(vs) == max(vs) else "v%d-%d" % (min(vs), max(vs))
                chs = {g.get("ch", 1) for g in group}
                ch_s = "" if chs == {1} else "  ch" + ",".join(str(c) for c in sorted(chs))
                lines.append("  %-6s %s  %s%s" % (fmt_beat(group[0]["beat"]), notes_s, vel_s, ch_s))
            group = [n] if n is not None else []
    return "\n".join(lines)


def render_items(items: Sequence[dict], detail: Optional[bool] = None) -> str:
    total = sum(len(i.get("notes", [])) for i in items)
    auto = detail is None
    if auto:
        detail = total <= 800
    out = [render_item(i, detail) for i in items]
    if auto and not detail:
        out.append("(ノートが多いので詳細を省略しました。--detail で全ノート、--bars で範囲指定できます)")
    return "\n\n".join(out)


# ---------------------------------------------------------------------------
# 小節グリッド (REAPER を介さないとき用)
# ---------------------------------------------------------------------------

class Meter:
    """拍子の変化 [(開始小節, num, denom), ...] から小節⇔QN を計算する。"""

    def __init__(self, changes: Sequence[Tuple[int, int, int]] = ((1, 4, 4),)):
        self.changes = sorted(changes) or [(1, 4, 4)]
        if self.changes[0][0] != 1:
            self.changes.insert(0, (1, 4, 4))

    def bar_info(self, bar: int) -> dict:
        qn = 0.0
        for i, (start_bar, num, denom) in enumerate(self.changes):
            next_bar = self.changes[i + 1][0] if i + 1 < len(self.changes) else None
            bar_len = num * 4.0 / denom
            if next_bar is None or bar < next_bar:
                s = qn + (bar - start_bar) * bar_len
                return {"bar": bar, "start": s, "end": s + bar_len, "num": num, "denom": denom}
            qn += (next_bar - start_bar) * bar_len
        raise AssertionError("unreachable")

    def to_qn(self, bar: float, beat: float = 1) -> float:
        info = self.bar_info(int(bar))
        return info["start"] + (beat - 1) * 4.0 / info["denom"]

    def from_qn(self, qn: float) -> Tuple[int, float]:
        bar = 1
        while True:
            info = self.bar_info(bar)
            if qn < info["end"] - 1e-9:
                return bar, 1 + (qn - info["start"]) * info["denom"] / 4.0
            bar += 1

    def bars_between(self, start_qn: float, end_qn: float) -> List[dict]:
        b0, _ = self.from_qn(start_qn)
        b1, _ = self.from_qn(max(start_qn, end_qn - 1e-6))
        return [self.bar_info(b) for b in range(b0, b1 + 1)]


def meter_from_doc(doc: dict) -> Meter:
    ts = doc.get("timesig") or [4, 4]
    changes = [(1, int(ts[0]), int(ts[1]))]
    for c in doc.get("timesig_changes", []):
        changes.append((int(c["bar"]), int(c["num"]), int(c["denom"])))
    return Meter(changes)


# ---------------------------------------------------------------------------
# 書き込み用 JSON の正規化
# ---------------------------------------------------------------------------

def load_parts(doc: Any) -> Tuple[List[dict], dict]:
    """書き込み用 JSON から parts のリストと共通設定を取り出す。"""
    if isinstance(doc, list):
        return [dict(p) for p in doc], {}
    if not isinstance(doc, dict):
        raise ValueError("JSON のトップレベルはオブジェクトか配列にしてください")
    if "parts" in doc:
        common = {k: v for k, v in doc.items() if k != "parts"}
        return [dict(p) for p in doc["parts"]], common
    return [dict(doc)], {}


def normalize_part(part: dict) -> dict:
    """音名・ドラム名をノート番号にし、明らかな誤りを先に見つける。"""
    out = dict(part)
    problems = []
    notes = []
    for i, n in enumerate(part.get("notes", [])):
        n = dict(n)
        try:
            n["pitch"] = parse_pitch(n.get("pitch"))
        except ValueError as e:
            problems.append("notes[%d]: %s" % (i + 1, e))
        if "start" not in n and "bar" not in n:
            problems.append("notes[%d]: start (QN) か bar/beat が必要です" % (i + 1))
        if not isinstance(n.get("len"), (int, float)) or n.get("len", 0) <= 0:
            problems.append("notes[%d]: len (四分音符単位, >0) が必要です" % (i + 1))
        notes.append(n)
    out["notes"] = notes
    if problems:
        raise ValueError("入力に誤りがあります:\n- " + "\n- ".join(problems[:10]))
    if not notes and not part.get("cc"):
        raise ValueError("notes も cc も空です")
    return out


def part_to_item(part: dict, meter: Meter) -> dict:
    """書き込み用 part を表示/書き出し用の item 形式に (REAPER なしで)。"""
    notes = []
    for n in part.get("notes", []):
        s = float(n["start"]) if "start" in n else meter.to_qn(n["bar"], n.get("beat", 1))
        bar, beat = meter.from_qn(s)
        notes.append({"pitch": parse_pitch(n["pitch"]), "start": s, "len": float(n["len"]),
                      "bar": bar, "beat": beat, "vel": int(n.get("vel", 96)), "ch": int(n.get("ch", 1))})
    ccs = []
    for c in part.get("cc", []):
        s = float(c["start"]) if "start" in c else meter.to_qn(c["bar"], c.get("beat", 1))
        bar, beat = meter.from_qn(s)
        ev = dict(c)
        ev.update({"start": s, "bar": bar, "beat": beat, "type": c.get("type", "cc"), "ch": int(c.get("ch", 1))})
        ccs.append(ev)
    if part.get("program") is not None and notes:
        first = min(n["start"] for n in notes)
        bar, beat = meter.from_qn(first)
        ccs.insert(0, {"type": "pc", "val": int(part["program"]), "start": meter.bar_info(bar)["start"],
                       "bar": bar, "beat": 1, "ch": int(part.get("program_ch", notes[0]["ch"]))})
    events = [n["start"] for n in notes] + [c["start"] for c in ccs]
    ends = [n["start"] + n["len"] for n in notes] + [c["start"] for c in ccs]
    bars = meter.bars_between(min(events), max(ends)) if events else []
    return {
        "track": part.get("track", ""), "take_name": part.get("name", ""),
        "start_bar": bars[0]["bar"] if bars else 1, "end_bar": bars[-1]["bar"] if bars else 1,
        "timesig": [bars[0]["num"], bars[0]["denom"]] if bars else [4, 4],
        "bars": bars, "notes": notes, "cc": ccs,
    }


# ---------------------------------------------------------------------------
# Standard MIDI File
# ---------------------------------------------------------------------------

def _read_varlen(data: bytes, pos: int) -> Tuple[int, int]:
    value = 0
    while True:
        b = data[pos]
        pos += 1
        value = (value << 7) | (b & 0x7F)
        if not b & 0x80:
            return value, pos


def _write_varlen(value: int) -> bytes:
    if value < 0:
        raise ValueError("負の時間は書き出せません")
    buf = [value & 0x7F]
    value >>= 7
    while value:
        buf.append((value & 0x7F) | 0x80)
        value >>= 7
    return bytes(reversed(buf))


def read_smf(path: Path) -> dict:
    """.mid を読んで {"items": [...], "tempo":, "timesig":} を返す (QN 単位)。"""
    data = Path(path).read_bytes()
    if data[:4] != b"MThd":
        raise ValueError("Standard MIDI File ではありません: %s" % path)
    hlen = struct.unpack(">I", data[4:8])[0]
    fmt, ntracks, division = struct.unpack(">HHH", data[8:14])
    if division & 0x8000:
        raise ValueError("SMPTE タイムベースの MIDI には対応していません")
    ppq = float(division)
    pos = 8 + hlen
    tempo = None
    ts_changes: List[Tuple[float, int, int]] = []
    raw_tracks = []
    for _ in range(ntracks):
        if data[pos:pos + 4] != b"MTrk":
            break
        tlen = struct.unpack(">I", data[pos + 4:pos + 8])[0]
        chunk = data[pos + 8:pos + 8 + tlen]
        pos += 8 + tlen
        name = ""
        notes, ccs = [], []
        open_notes: Dict[Tuple[int, int], List[Tuple[int, int]]] = {}
        tick, i, status = 0, 0, 0
        while i < len(chunk):
            delta, i = _read_varlen(chunk, i)
            tick += delta
            b = chunk[i]
            if b == 0xFF:
                mtype = chunk[i + 1]
                mlen, i = _read_varlen(chunk, i + 2)
                payload = chunk[i:i + mlen]
                i += mlen
                if mtype == 0x03 and not name:
                    name = payload.decode("utf-8", errors="replace")
                elif mtype == 0x51 and tempo is None and len(payload) == 3:
                    tempo = 60_000_000 / int.from_bytes(payload, "big")
                elif mtype == 0x58 and len(payload) >= 2:
                    ts_changes.append((tick / ppq, payload[0], 2 ** payload[1]))
                continue
            if b in (0xF0, 0xF7):
                slen, i = _read_varlen(chunk, i + 1)
                i += slen
                continue
            if b & 0x80:
                status = b
                i += 1
            kind, ch = status & 0xF0, status & 0x0F
            if kind in (0xC0, 0xD0):
                d1, d2 = chunk[i], 0
                i += 1
            else:
                d1, d2 = chunk[i], chunk[i + 1]
                i += 2
            qn = tick / ppq
            if kind == 0x90 and d2 > 0:
                open_notes.setdefault((ch, d1), []).append((tick, d2))
            elif kind == 0x80 or (kind == 0x90 and d2 == 0):
                stack = open_notes.get((ch, d1))
                if stack:
                    on_tick, vel = stack.pop(0)
                    notes.append({"pitch": d1, "start": on_tick / ppq, "len": max(tick - on_tick, 1) / ppq, "vel": vel, "ch": ch + 1})
            elif kind == 0xB0:
                ccs.append({"type": "cc", "cc": d1, "val": d2, "start": qn, "ch": ch + 1})
            elif kind == 0xC0:
                ccs.append({"type": "pc", "val": d1, "start": qn, "ch": ch + 1})
            elif kind == 0xE0:
                ccs.append({"type": "pb", "val": d2 * 128 + d1 - 8192, "start": qn, "ch": ch + 1})
        raw_tracks.append((name, notes, ccs))

    ts_changes.sort()
    first_ts = (ts_changes[0][1], ts_changes[0][2]) if ts_changes and ts_changes[0][0] == 0 else (4, 4)
    meter = Meter([(1, first_ts[0], first_ts[1])])
    for qn, num, denom in ts_changes:
        if qn > 0:
            bar, beat = meter.from_qn(qn)
            if abs(beat - 1) > 1e-6:
                bar += 1  # 小節の途中の拍子変更は次の小節から
            meter = Meter(list(meter.changes) + [(bar, num, denom)])

    items = []
    for idx, (name, notes, ccs) in enumerate(raw_tracks):
        if not notes and not any(c["type"] == "cc" and c["cc"] == 64 for c in ccs):
            continue
        for ev in notes + ccs:
            ev["bar"], ev["beat"] = meter.from_qn(ev["start"])
        notes.sort(key=lambda n: (n["start"], n["pitch"]))
        starts = [n["start"] for n in notes] or [c["start"] for c in ccs]
        ends = [n["start"] + n["len"] for n in notes] or [c["start"] for c in ccs]
        bars = meter.bars_between(min(starts), max(ends))
        items.append({
            "track": name or "Track %d" % (idx + 1), "start_bar": bars[0]["bar"], "end_bar": bars[-1]["bar"],
            "timesig": [bars[0]["num"], bars[0]["denom"]], "tempo": tempo, "bars": bars, "notes": notes, "cc": ccs,
        })
    return {"format": fmt, "tempo": tempo or 120.0, "timesig": list(first_ts), "items": items}


def write_smf(path: Path, items: Sequence[dict], tempo: float = 120.0, timesig: Sequence[int] = (4, 4), ppq: int = 960) -> None:
    """items (QN 単位の notes / cc) を type 1 の .mid に書き出す。"""
    def track_chunk(events: List[Tuple[int, int, bytes]]) -> bytes:
        events.sort(key=lambda e: (e[0], e[1]))
        out, last = bytearray(), 0
        for tick, _, msg in events:
            out += _write_varlen(tick - last) + msg
            last = tick
        out += _write_varlen(0) + b"\xFF\x2F\x00"
        return b"MTrk" + struct.pack(">I", len(out)) + bytes(out)

    denom_pow = {1: 0, 2: 1, 4: 2, 8: 3, 16: 4, 32: 5}[int(timesig[1])]
    us = int(round(60_000_000 / tempo))
    conductor = [
        (0, 0, b"\xFF\x51\x03" + us.to_bytes(3, "big")),
        (0, 0, bytes([0xFF, 0x58, 0x04, int(timesig[0]), denom_pow, 24, 8])),
    ]
    chunks = [track_chunk(conductor)]
    for item in items:
        evs: List[Tuple[int, int, bytes]] = []
        name = (item.get("track") or "").encode("utf-8")
        if name:
            evs.append((0, 0, b"\xFF\x03" + _write_varlen(len(name)) + name))
        for c in item.get("cc", []):
            tick = max(0, int(round(float(c["start"]) * ppq)))
            ch = int(c.get("ch", 1)) - 1
            kind = c.get("type", "cc")
            if kind == "cc":
                evs.append((tick, 1, bytes([0xB0 | ch, int(c["cc"]), int(c["val"])])))
            elif kind == "pc":
                evs.append((tick, 1, bytes([0xC0 | ch, int(c["val"])])))
            elif kind == "pb":
                v = int(c["val"]) + 8192
                evs.append((tick, 1, bytes([0xE0 | ch, v & 0x7F, v >> 7])))
        for n in item.get("notes", []):
            ch = int(n.get("ch", 1)) - 1
            s = max(0, int(round(float(n["start"]) * ppq)))  # 曲頭より前は曲頭に寄せる
            e = max(s + 1, int(round((float(n["start"]) + float(n["len"])) * ppq)))
            p = parse_pitch(n["pitch"])
            evs.append((s, 2, bytes([0x90 | ch, p, int(n.get("vel", 96))])))
            evs.append((e, 0, bytes([0x80 | ch, p, 0])))  # 同時刻ならノートオフを先に
        chunks.append(track_chunk(evs))
    header = b"MThd" + struct.pack(">IHHH", 6, 1, len(chunks), ppq)
    Path(path).write_bytes(header + b"".join(chunks))


# ---------------------------------------------------------------------------
# ファイル読み込み (view / mid 用)
# ---------------------------------------------------------------------------

def load_items_from_file(path: Path) -> Tuple[List[dict], dict]:
    path = Path(path)
    if path.suffix.lower() in (".mid", ".midi", ".smf"):
        doc = read_smf(path)
        return doc["items"], {"tempo": doc["tempo"], "timesig": doc["timesig"]}
    doc = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(doc, dict) and "items" in doc:   # read --save の出力
        return doc["items"], {}
    parts, common = load_parts(doc)
    meter = meter_from_doc(common if common else (parts[0] if parts else {}))
    items = [part_to_item(normalize_part(p), meter) for p in parts]
    return items, {"tempo": common.get("tempo") or (parts[0].get("tempo") if parts else None),
                   "timesig": (common.get("timesig") or (parts[0].get("timesig") if parts else None) or [4, 4])}


def filter_bars(items: List[dict], bar_range: Optional[Tuple[int, int]]) -> List[dict]:
    if not bar_range:
        return items
    lo, hi = bar_range
    out = []
    for it in items:
        it = dict(it)
        it["notes"] = [n for n in it.get("notes", []) if lo <= n["bar"] <= hi]
        it["cc"] = [c for c in it.get("cc", []) if lo <= c["bar"] <= hi]
        it["bars"] = [b for b in it.get("bars", []) if lo <= b["bar"] <= hi]
        if it["bars"]:
            it["start_bar"], it["end_bar"] = it["bars"][0]["bar"], it["bars"][-1]["bar"]
        out.append(it)
    return out


def parse_bar_range(s: Optional[str]) -> Optional[Tuple[int, int]]:
    if not s:
        return None
    m = re.match(r"^\s*(\d+)\s*(?:-\s*(\d+))?\s*$", s)
    if not m:
        raise ValueError("--bars は 5-12 のように指定してください")
    lo = int(m.group(1))
    hi = int(m.group(2) or lo)
    if hi < lo:
        raise ValueError("--bars の範囲が逆です")
    return lo, hi


# ---------------------------------------------------------------------------
# コマンド
# ---------------------------------------------------------------------------

def print_json(v: Any) -> None:
    print(json.dumps(v, ensure_ascii=False, indent=2))


def render_project(p: dict) -> str:
    lines = ["# %s   %s BPM  %s/%s   %s bars   cursor %s.%s%s" % (
        p.get("name") or "(未保存のプロジェクト)", fmt_num(p["tempo"], 2), p["timesig"][0], p["timesig"][1],
        p.get("length_bars", 0), p["cursor"]["bar"], fmt_beat(p["cursor"]["beat"]),
        "   ▶ playing" if p.get("playing") else "")]
    if len(p.get("tempo_map", [])) > 1:
        lines.append("tempo/timesig: " + ", ".join(
            "bar %s %s BPM%s" % (t["bar"], fmt_num(t["bpm"], 2), " %s/%s" % (t["num"], t["denom"]) if t.get("num") else "")
            for t in p["tempo_map"]))
    if p.get("time_selection"):
        t = p["time_selection"]
        lines.append("time selection: %s.%s - %s.%s" % (t["start_bar"], fmt_beat(t["start_beat"]), t["end_bar"], fmt_beat(t["end_beat"])))
    lines.append("")
    lines.append("tracks:")
    for t in p.get("tracks", []):
        flags = []
        if t.get("mute"):
            flags.append("M")
        if t.get("solo"):
            flags.append("S")
        if t.get("ai"):
            flags.append("AI")
        span = " bars %s-%s" % (t["first_bar"], t["last_bar"]) if t.get("first_bar") else ""
        fx = ("  fx: " + ", ".join(t["fx"])) if t.get("fx") else "  fx: (なし)"
        lines.append("  %2d. %-24s items %d (midi %d)%s%s%s" % (
            t["number"], t["name"] or "(no name)", t["items"], t["midi_items"], span,
            " [" + ",".join(flags) + "]" if flags else "", fx))
    if p.get("markers"):
        lines.append("")
        lines.append("markers / regions:")
        for m in p["markers"]:
            if m.get("region"):
                lines.append("  [region] %-16s bars %s-%s" % (m["name"] or "(no name)", m["bar"], m.get("end_bar")))
            else:
                lines.append("  [marker] %-16s bar %s.%s" % (m["name"] or "(no name)", m["bar"], fmt_beat(m["beat"])))
    if p.get("selected_items"):
        lines.append("")
        lines.append("選択中のアイテム: %d" % p["selected_items"])
    return "\n".join(lines)


def cmd_status(a) -> int:
    age = heartbeat_age()
    if age is None or age > HEARTBEAT_MAX_AGE:
        print(NOT_RUNNING_HELP)
        print("(連携フォルダ: %s)" % (BASE_DIR / ".bridge"))
        return EXIT_NO_BRIDGE
    r = call("ping")
    print("OK: bridge %s / REAPER %s / project: %s" % (r["bridge_version"], r["reaper_version"], r.get("project") or "(未保存)"))
    return EXIT_OK


def cmd_selftest(a) -> int:
    r = call("selftest")
    if a.json:
        print_json(r)
    else:
        bad = [c for c in r["checks"] if not c["ok"]]
        print("selftest: %s (bar1_qn=%s, %d checks)" % ("OK" if r["ok"] else "NG", r["bar1_qn"], len(r["checks"])))
        for c in bad:
            print("  NG bar %s beat %s -> qn %s -> bar %s beat %s" % (c["bar"], c["beat"], c["qn"], c["back_bar"], c["back_beat"]))
    return EXIT_OK if r["ok"] else EXIT_OP_ERROR


def cmd_project(a) -> int:
    r = call("project")
    print_json(r) if a.json else print(render_project(r))
    return EXIT_OK


def cmd_read(a) -> int:
    bar_range = parse_bar_range(a.bars)
    args: Dict[str, Any] = {}
    if a.item:
        args["item"] = a.item
    elif a.track:
        args["track"] = int(a.track) if a.track.isdigit() else a.track
    if bar_range:
        args["start_bar"], args["end_bar"] = bar_range
    r = call("read_midi", args)
    if a.save:
        Path(a.save).expanduser().parent.mkdir(parents=True, exist_ok=True)
        Path(a.save).expanduser().write_text(json.dumps(r, ensure_ascii=False, indent=1), encoding="utf-8")
        print("saved: %s" % a.save, file=sys.stderr)
    if a.json:
        print_json(r)
    else:
        print(render_items(r["items"], True if a.detail else (False if a.summary else None)))
    return EXIT_OK


def cmd_write(a) -> int:
    doc = json.loads(Path(a.file).expanduser().read_text(encoding="utf-8"))
    parts, common = load_parts(doc)
    shared = {k: v for k, v in common.items() if k in ("instrument", "after", "create")}
    normalized = []
    for p in parts:
        merged = dict(shared)
        merged.update(p)
        normalized.append(normalize_part(merged))
    if a.dry_run:
        meter = meter_from_doc(common if common else parts[0])
        print(render_items([part_to_item(p, meter) for p in normalized], True))
        return EXIT_OK
    results = []
    for p in normalized:
        args = {k: v for k, v in p.items() if k not in ("timesig", "tempo", "timesig_changes")}
        results.append(call("write_midi", args, timeout=60))
    if a.json:
        print_json(results)
    else:
        for r in results:
            line = "wrote: %s (track %d%s) bars %s-%s  notes %d  cc %d  item %s" % (
                r["track"], r["track_number"], ", 新規トラック" if r.get("created_track") else "",
                r["start_bar"], r["end_bar"], r["notes"], r["cc"], r["item"])
            if r.get("instrument"):
                line += "  instrument: %s" % r["instrument"]
            print(line)
            for w in r.get("warnings", []):
                print("  warning: %s" % w)
    return EXIT_OK


def cmd_view(a) -> int:
    items, info = load_items_from_file(Path(a.file).expanduser())
    for it in items:
        it.setdefault("tempo", info.get("tempo"))
    items = filter_bars(items, parse_bar_range(a.bars))
    if a.json:
        print_json({"items": items, **info})
    else:
        print(render_items(items, True if a.detail else (False if a.summary else None)))
    return EXIT_OK


def cmd_mid(a) -> int:
    items, info = load_items_from_file(Path(a.file).expanduser())
    tempo = a.tempo or info.get("tempo") or 120.0
    write_smf(Path(a.out).expanduser(), items, tempo=float(tempo), timesig=info.get("timesig") or (4, 4))
    print("wrote %s (%d tracks, %s BPM)" % (a.out, len(items), fmt_num(float(tempo), 2)))
    return EXIT_OK


def cmd_play(a) -> int:
    args: Dict[str, Any] = {"action": "play"}
    if a.bar:
        args["bar"] = a.bar
    if a.loop:
        lo, hi = parse_bar_range(a.loop)
        args["loop_start_bar"], args["loop_end_bar"] = lo, hi
        args.setdefault("bar", lo)
    r = call("transport", args)
    print("playing from bar %s" % r["cursor"]["bar"])
    return EXIT_OK


def cmd_stop(a) -> int:
    call("transport", {"action": "stop"})
    print("stopped")
    return EXIT_OK


def cmd_track(a) -> int:
    args: Dict[str, Any] = {"track": int(a.track) if a.track.isdigit() else a.track}
    if a.mute or a.unmute:
        args["mute"] = bool(a.mute)
    if a.solo or a.unsolo:
        args["solo"] = bool(a.solo)
    if a.volume is not None:
        args["volume_db"] = a.volume
    if a.rename:
        args["rename"] = a.rename
    if a.delete:
        args["delete"] = True
        args["force"] = a.force
    print_json(call("track", args))
    return EXIT_OK


def cmd_markers(a) -> int:
    regions = []
    for spec in a.region or []:
        m = re.match(r"^(.+?):(\d+)-(\d+)$", spec)
        if not m:
            raise ValueError("--region は 'サビ:17-24' の形で指定してください")
        regions.append({"name": m.group(1), "start_bar": int(m.group(2)), "end_bar": int(m.group(3))})
    markers = []
    for spec in a.marker or []:
        m = re.match(r"^(.+?):(\d+)$", spec)
        if not m:
            raise ValueError("--marker は 'ブレイク:32' の形で指定してください")
        markers.append({"name": m.group(1), "bar": int(m.group(2))})
    print_json(call("add_markers", {"regions": regions, "markers": markers}))
    return EXIT_OK


def cmd_fx(a) -> int:
    r = call("list_fx", {"filter": a.filter, "instruments": a.instruments, "limit": a.limit})
    for fx in r["fx"]:
        print(fx["name"])
    if r["total"] > len(r["fx"]):
        print("... ほか %d 件 (--filter で絞り込めます)" % (r["total"] - len(r["fx"])))
    return EXIT_OK


def cmd_addfx(a) -> int:
    print_json(call("add_fx", {"track": a.track, "fx": a.fx, "show": a.show}))
    return EXIT_OK


def cmd_lua(a) -> int:
    code = a.code if a.code is not None else Path(a.file).expanduser().read_text(encoding="utf-8")
    r = call("lua", {"code": code}, timeout=60)
    if r.get("output"):
        print(r["output"])
    if r.get("result") is not None:
        print_json(r["result"])
    return EXIT_OK


def cmd_call(a) -> int:
    args = {}
    if a.args:
        src = Path(a.args[1:]).expanduser().read_text(encoding="utf-8") if a.args.startswith("@") else a.args
        args = json.loads(src)
    print_json(call(a.op, args, timeout=a.timeout))
    return EXIT_OK


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="reaper_ai.py", description="REAPER を Claude Code から操作する")
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("status", help="ブリッジが動いているか確認").set_defaults(fn=cmd_status)
    s = sub.add_parser("selftest", help="小節/拍の変換が REAPER と合っているか確認")
    s.add_argument("--json", action="store_true")
    s.set_defaults(fn=cmd_selftest)

    s = sub.add_parser("project", help="プロジェクトの概要")
    s.add_argument("--json", action="store_true")
    s.set_defaults(fn=cmd_project)

    s = sub.add_parser("read", help="MIDI を読む (既定: 選択中のアイテム)")
    s.add_argument("--track", help="トラック名か番号")
    s.add_argument("--item", help="アイテムの GUID")
    s.add_argument("--bars", help="小節の範囲 (例: 1-8)")
    s.add_argument("--json", action="store_true", help="生の JSON を出す")
    s.add_argument("--save", help="JSON をファイルに保存")
    g = s.add_mutually_exclusive_group()
    g.add_argument("--detail", action="store_true", help="全ノートを表示")
    g.add_argument("--summary", action="store_true", help="調とコードだけ表示")
    s.set_defaults(fn=cmd_read)

    s = sub.add_parser("write", help="JSON の MIDI を書き込む")
    s.add_argument("file")
    s.add_argument("--dry-run", action="store_true", help="書き込まずに内容を表示")
    s.add_argument("--json", action="store_true")
    s.set_defaults(fn=cmd_write)

    s = sub.add_parser("view", help=".mid / .json を表示 (REAPER 不要)")
    s.add_argument("file")
    s.add_argument("--bars")
    s.add_argument("--json", action="store_true")
    g = s.add_mutually_exclusive_group()
    g.add_argument("--detail", action="store_true")
    g.add_argument("--summary", action="store_true")
    s.set_defaults(fn=cmd_view)

    s = sub.add_parser("mid", help=".json (または .mid) を .mid に書き出す (REAPER 不要)")
    s.add_argument("file")
    s.add_argument("out")
    s.add_argument("--tempo", type=float)
    s.set_defaults(fn=cmd_mid)

    s = sub.add_parser("play", help="再生")
    s.add_argument("--bar", type=int, help="この小節から")
    s.add_argument("--loop", help="ループ範囲 (例: 9-16)")
    s.set_defaults(fn=cmd_play)
    sub.add_parser("stop", help="停止").set_defaults(fn=cmd_stop)

    s = sub.add_parser("track", help="トラックのミュート・ソロ・音量・名前・削除")
    s.add_argument("track")
    s.add_argument("--mute", action="store_true")
    s.add_argument("--unmute", action="store_true")
    s.add_argument("--solo", action="store_true")
    s.add_argument("--unsolo", action="store_true")
    s.add_argument("--volume", type=float, help="dB")
    s.add_argument("--rename")
    s.add_argument("--delete", action="store_true", help="AI が作ったトラックだけ削除できる")
    s.add_argument("--force", action="store_true", help="ユーザーのトラックでも削除する")
    s.set_defaults(fn=cmd_track)

    s = sub.add_parser("markers", help="リージョン/マーカーを追加")
    s.add_argument("--region", action="append", help="'Aメロ:1-8' (両端の小節を含む)")
    s.add_argument("--marker", action="append", help="'ブレイク:32'")
    s.set_defaults(fn=cmd_markers)

    s = sub.add_parser("fx", help="インストール済みの FX/音源を一覧")
    s.add_argument("--filter")
    s.add_argument("--instruments", action="store_true", help="音源だけ")
    s.add_argument("--limit", type=int, default=200)
    s.set_defaults(fn=cmd_fx)

    s = sub.add_parser("addfx", help="トラックに FX/音源を追加")
    s.add_argument("track")
    s.add_argument("fx")
    s.add_argument("--show", action="store_true", help="プラグイン画面を開く")
    s.set_defaults(fn=cmd_addfx)

    s = sub.add_parser("lua", help="任意の ReaScript (Lua) を実行")
    g = s.add_mutually_exclusive_group(required=True)
    g.add_argument("file", nargs="?")
    g.add_argument("-e", dest="code")
    s.set_defaults(fn=cmd_lua)

    s = sub.add_parser("call", help="ブリッジの op を直接呼ぶ")
    s.add_argument("op")
    s.add_argument("args", nargs="?", help="JSON 文字列か @ファイル")
    s.add_argument("--timeout", type=float, default=30)
    s.set_defaults(fn=cmd_call)
    return p


def main(argv: Optional[Sequence[str]] = None) -> int:
    a = build_parser().parse_args(argv)
    try:
        return a.fn(a)
    except BridgeError as e:
        print("error: %s" % e, file=sys.stderr)
        return e.code
    except (ValueError, OSError) as e:
        print("error: %s" % e, file=sys.stderr)
        return EXIT_USAGE


if __name__ == "__main__":
    sys.exit(main())
