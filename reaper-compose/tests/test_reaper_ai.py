"""reaper_ai.py のテスト。

  python3 -m unittest discover -s tests -p 'test_*.py'

統合テスト (IntegrationTest) は lua5.4 があるときだけ、モックの REAPER の上で
本物の ai_bridge.lua を常駐させて CLI を通しで動かす。
"""
from __future__ import annotations

import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

SKILL_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SKILL_DIR / "scripts"))
import reaper_ai as ra  # noqa: E402

LUA = shutil.which("lua5.4") or shutil.which("lua")


def bar(n, num=4, denom=4, start=None):
    length = num * 4.0 / denom
    s = (n - 1) * length if start is None else start
    return {"bar": n, "start": s, "end": s + length, "num": num, "denom": denom}


def note(pitch, start, length, vel=80, ch=1):
    return {"pitch": pitch, "start": start, "len": length, "vel": vel, "ch": ch}


class PitchTest(unittest.TestCase):
    def test_parse(self):
        self.assertEqual(ra.parse_pitch("C4"), 60)
        self.assertEqual(ra.parse_pitch("Bb2"), 46)
        self.assertEqual(ra.parse_pitch("F#3"), 54)
        self.assertEqual(ra.parse_pitch("c-1"), 0)
        self.assertEqual(ra.parse_pitch("G9"), 127)
        self.assertEqual(ra.parse_pitch("E♭4"), 63)
        self.assertEqual(ra.parse_pitch(" A1 "), 33)
        self.assertEqual(ra.parse_pitch(60), 60)
        self.assertEqual(ra.parse_pitch(60.0), 60)
        self.assertEqual(ra.parse_pitch("kick"), 36)
        self.assertEqual(ra.parse_pitch("Closed HH"), 42)
        for bad in ("H2", "C", "G#9", 128, -1, True, None, 60.5):
            with self.assertRaises(ValueError, msg=repr(bad)):
                ra.parse_pitch(bad)

    def test_names(self):
        self.assertEqual(ra.pitch_name(60), "C4")
        self.assertEqual(ra.pitch_name(61), "C#4")
        self.assertEqual(ra.pitch_name(61, flats=True), "Db4")
        self.assertEqual(ra.pitch_name(21), "A0")


class KeyAndChordTest(unittest.TestCase):
    def weights(self, pcs, bass=None):
        w = [0.0] * 12
        for pc in pcs:
            w[pc % 12] += 1.0
        return w

    def chord(self, pcs, bass=None, flats=False):
        m = ra.match_chord(self.weights(pcs), bass)
        self.assertIsNotNone(m)
        _, root, suffix = m
        return ra.chord_symbol(root, suffix, bass, flats)

    def test_triads_and_sevenths(self):
        self.assertEqual(self.chord([0, 4, 7], 0), "C")
        self.assertEqual(self.chord([9, 0, 4], 9), "Am")
        self.assertEqual(self.chord([9, 0, 4, 7], 9), "Am7")
        self.assertEqual(self.chord([7, 11, 2, 5], 7), "G7")
        self.assertEqual(self.chord([5, 9, 0, 4], 5), "Fmaj7")
        self.assertEqual(self.chord([11, 2, 5, 9], 11), "Bm7b5")
        self.assertEqual(self.chord([0, 5, 7], 0), "Csus4")
        self.assertEqual(self.chord([2, 5, 9, 0, 4], 2), "Dm9")

    def test_inversions_and_ambiguity(self):
        self.assertEqual(self.chord([0, 4, 7], 4), "C/E")
        self.assertEqual(self.chord([7, 11, 2], 11), "G/B")
        self.assertEqual(self.chord([0, 4, 7, 9], 0), "C6")
        self.assertEqual(self.chord([0, 4, 7, 9], 9), "Am7")
        self.assertEqual(self.chord([10, 2, 5], 10, flats=True), "Bb")

    def test_slash_chord_reads_upper_voices(self):
        # 下降ベース: | C | G/B | Am | Am/G |
        notes = []
        for i, (bass, upper) in enumerate(((36, (55, 60, 64)), (35, (55, 59, 62)), (33, (57, 60, 64)), (31, (57, 60, 64)))):
            notes.append(note(bass, i * 4, 4))
            notes += [note(p, i * 4, 4) for p in upper]
        chords = ra.analyze_chords(notes, [], [bar(i) for i in range(1, 5)], flats=False)
        self.assertEqual([chords[i][0][1] for i in range(1, 5)], ["C", "G/B", "Am", "Am/G"])

    def test_single_note_is_not_a_chord(self):
        self.assertIsNone(ra.match_chord(self.weights([0]), 0))
        self.assertIsNone(ra.match_chord([0.0] * 12, None))

    def test_key(self):
        c_major = [0, 2, 4, 5, 7, 9, 11, 0, 4, 7, 0, 7]
        hist = [0.0] * 12
        for pc in c_major:
            hist[pc] += 1
        top = ra.estimate_key(hist)[0]
        self.assertEqual((top[1], top[2]), (0, "major"))
        a_minor = [9, 11, 0, 2, 4, 5, 8, 9, 9, 4, 4, 0, 0, 8]
        hist = [0.0] * 12
        for pc in a_minor:
            hist[pc] += 1
        top = ra.estimate_key(hist)[0]
        self.assertEqual((top[1], top[2]), (9, "minor"))
        self.assertEqual(ra.key_label(10, "major"), "Bb major")
        self.assertEqual(ra.estimate_key([0.0] * 12), [])

    def test_progression(self):
        notes = []
        # | C | Am | F  G | C |
        for p in (48, 55, 64, 67):
            notes.append(note(p, 0, 4))
        for p in (45, 52, 60, 64):
            notes.append(note(p, 4, 4))
        for p in (41, 53, 57, 60):
            notes.append(note(p, 8, 2))
        for p in (43, 50, 59, 62):
            notes.append(note(p, 10, 2))
        for p in (36, 55, 64, 72):
            notes.append(note(p, 12, 4))
        notes.append(note(74, 1, 0.5))  # 経過音
        bars = [bar(i) for i in range(1, 5)]
        chords = ra.analyze_chords(notes, [], bars, flats=False)
        self.assertEqual([s for _, s in chords[1]], ["C"])
        self.assertEqual([s for _, s in chords[2]], ["Am"])
        self.assertEqual(chords[3], [(1, "F"), (3, "G")])
        self.assertEqual([s for _, s in chords[4]], ["C"])

    def test_sustain_pedal_extends_notes(self):
        notes = [note(48, 0, 0.25), note(52, 1, 0.25), note(55, 2, 0.25)]
        ccs = [{"type": "cc", "cc": 64, "val": 127, "start": 0, "ch": 1}, {"type": "cc", "cc": 64, "val": 0, "start": 3.9, "ch": 1}]
        snd = ra.sounding_notes(notes, ccs)
        self.assertEqual([x[2] for x in snd], [3.9, 3.9, 3.9])
        chords = ra.analyze_chords(notes, ccs, [bar(1)], flats=False)
        self.assertEqual(chords[1], [(1, "C")])
        # ペダルなしなら伸びない
        self.assertEqual(ra.sounding_notes(notes, [])[0][2], 0.25)

    def test_pedal_held_across_a_chord_change(self):
        # ペダルを踏み替えずに C → F。前の和音の残りで F が Fmaj9 などにならないこと
        notes = [note(p, 0, 3.8) for p in (48, 52, 55, 60)] + [note(p, 4, 3.8) for p in (41, 53, 57, 60)]
        ccs = [{"type": "cc", "cc": 64, "val": 127, "start": 0, "ch": 1}, {"type": "cc", "cc": 64, "val": 0, "start": 8, "ch": 1}]
        chords = ra.analyze_chords(notes, ccs, [bar(1), bar(2)], flats=False)
        self.assertEqual(chords[1], [(1, "C")])
        self.assertEqual(chords[2], [(1, "F")])

    def test_passing_tones_do_not_split_the_bar(self):
        notes = [note(p, 0, 4) for p in (48, 55, 64)] + [note(72, 0, 1), note(74, 1, 1), note(76, 2, 1), note(77, 3, 0.5), note(74, 3.5, 0.5)]
        chords = ra.analyze_chords(notes, [], [bar(1)], flats=False)
        self.assertEqual(chords[1], [(1, "C")])

    def test_arpeggio_without_pedal(self):
        # 左手の分散和音 (1 拍ずつ) でも小節単位でまとめて判定できること
        notes = [note(p, i, 1) for i, p in enumerate((45, 52, 57, 60))] + [note(p, 4 + i, 1) for i, p in enumerate((41, 48, 53, 57))]
        chords = ra.analyze_chords(notes, [], [bar(1), bar(2)], flats=False)
        self.assertEqual(chords[1], [(1, "Am")])
        self.assertEqual(chords[2], [(1, "F")])

    def test_rests_are_marked(self):
        # 和音のあとの休符は同じ小節のコードのまま。音のない小節は N.C.
        chords = ra.analyze_chords([note(60, 0, 1), note(64, 0, 1), note(67, 0, 1)], [], [bar(1), bar(2), bar(3)], flats=False)
        self.assertEqual(chords[1], [(1, "C")])
        self.assertEqual(chords[2], [(1, "N.C.")])
        self.assertEqual(chords[3], [(1, "N.C.")])

    def test_compound_meter_windows(self):
        b = bar(1, 6, 8)
        self.assertEqual([w[2] for w in ra.beat_windows(b)], [1, 4])
        self.assertEqual(len(ra.beat_windows(bar(1, 3, 4))), 3)


class MeterTest(unittest.TestCase):
    def test_changes(self):
        m = ra.Meter([(1, 4, 4), (3, 3, 4), (5, 6, 8)])
        self.assertEqual(m.to_qn(1), 0)
        self.assertEqual(m.to_qn(3), 8)
        self.assertEqual(m.to_qn(4), 11)
        self.assertEqual(m.to_qn(5), 14)
        self.assertEqual(m.to_qn(5, 2), 14.5)
        self.assertEqual(m.from_qn(14.5), (5, 2.0))
        b, beat = m.from_qn(10.999999)
        self.assertEqual(b, 3)
        self.assertAlmostEqual(beat, 3.999999, places=5)
        self.assertEqual(m.from_qn(11)[0], 4)
        self.assertEqual([b["bar"] for b in m.bars_between(7, 15)], [2, 3, 4, 5])


class SmfTest(unittest.TestCase):
    def test_roundtrip(self):
        items = [
            {"track": "ベース", "notes": [note(33, 0, 1.5, 90), note(40, 1.5, 0.5, 70, ch=2)],
             "cc": [{"type": "pc", "val": 33, "start": 0, "ch": 1}, {"type": "cc", "cc": 64, "val": 127, "start": 0.5, "ch": 1},
                    {"type": "pb", "val": -8192, "start": 1, "ch": 1}]},
            {"track": "Drums", "notes": [note(36, 0, 0.25, 100, ch=10), note(38, 1, 0.25, 100, ch=10), note(36, 1, 0.25, 100, ch=10)]},
        ]
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "t.mid"
            ra.write_smf(path, items, tempo=92, timesig=(3, 4))
            doc = ra.read_smf(path)
        self.assertAlmostEqual(doc["tempo"], 92, places=2)
        self.assertEqual(doc["timesig"], [3, 4])
        self.assertEqual([i["track"] for i in doc["items"]], ["ベース", "Drums"])
        bass = doc["items"][0]
        self.assertEqual([(n["pitch"], n["start"], n["len"], n["vel"], n["ch"]) for n in bass["notes"]],
                         [(33, 0.0, 1.5, 90, 1), (40, 1.5, 0.5, 70, 2)])
        kinds = sorted((c["type"], c["val"]) for c in bass["cc"])
        self.assertEqual(kinds, [("cc", 127), ("pb", -8192), ("pc", 33)])
        drums = doc["items"][1]
        self.assertEqual(len(drums["notes"]), 3)
        self.assertEqual(drums["notes"][2]["bar"], 1)
        self.assertEqual(bass["bars"][0]["num"], 3)

    def test_running_status_and_note_on_zero(self):
        # 手で組み立てた type 0: running status + velocity 0 の note on
        trk = bytes([0x00, 0x90, 60, 100, 0x60, 60, 0, 0x00, 64, 90, 0x60, 0x80, 64, 0, 0x00, 0xFF, 0x2F, 0x00])
        data = b"MThd" + (6).to_bytes(4, "big") + (0).to_bytes(2, "big") + (1).to_bytes(2, "big") + (96).to_bytes(2, "big")
        data += b"MTrk" + len(trk).to_bytes(4, "big") + trk
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "r.mid"
            path.write_bytes(data)
            doc = ra.read_smf(path)
        ns = doc["items"][0]["notes"]
        self.assertEqual([(n["pitch"], n["start"], n["len"]) for n in ns], [(60, 0.0, 1.0), (64, 1.0, 1.0)])

    def test_notes_before_zero_are_clamped(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "neg.mid"
            ra.write_smf(path, [{"track": "x", "notes": [note(60, -0.02, 1), note(64, 1, 1)],
                                 "cc": [{"type": "cc", "cc": 64, "val": 127, "start": -0.01, "ch": 1}]}])
            doc = ra.read_smf(path)
        self.assertEqual([n["start"] for n in doc["items"][0]["notes"]], [0.0, 1.0])

    def test_rejects_non_midi(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "x.mid"
            path.write_bytes(b"RIFF....")
            with self.assertRaises(ValueError):
                ra.read_smf(path)


class PartsTest(unittest.TestCase):
    def test_normalize_and_item(self):
        part = {"track": "Bass (AI)", "program": 33, "notes": [
            {"bar": 1, "beat": 1, "len": 1, "pitch": "A1"}, {"bar": 2, "beat": 3.5, "len": 0.5, "pitch": "E2", "vel": 70}]}
        n = ra.normalize_part(part)
        self.assertEqual([x["pitch"] for x in n["notes"]], [33, 40])
        item = ra.part_to_item(n, ra.Meter())
        self.assertEqual(item["notes"][1]["start"], 6.5)
        self.assertEqual(item["start_bar"], 1)
        self.assertEqual(item["end_bar"], 2)
        self.assertEqual(item["cc"][0]["type"], "pc")

    def test_normalize_reports_all_problems(self):
        with self.assertRaises(ValueError) as cm:
            ra.normalize_part({"notes": [{"bar": 1, "pitch": "X9", "len": 1}, {"pitch": 60, "len": 1}, {"bar": 1, "pitch": 60}]})
        msg = str(cm.exception)
        self.assertIn("notes[1]", msg)
        self.assertIn("notes[2]", msg)
        self.assertIn("notes[3]", msg)

    def test_load_parts_shapes(self):
        self.assertEqual(len(ra.load_parts({"notes": []})[0]), 1)
        parts, common = ra.load_parts({"timesig": [3, 4], "parts": [{"track": "a"}, {"track": "b"}]})
        self.assertEqual(len(parts), 2)
        self.assertEqual(common["timesig"], [3, 4])
        self.assertEqual(len(ra.load_parts([{"track": "a"}])[0]), 1)

    def test_bar_range(self):
        self.assertEqual(ra.parse_bar_range("5-12"), (5, 12))
        self.assertEqual(ra.parse_bar_range("3"), (3, 3))
        self.assertIsNone(ra.parse_bar_range(None))
        for bad in ("a-b", "9-3"):
            with self.assertRaises(ValueError):
                ra.parse_bar_range(bad)


class RenderTest(unittest.TestCase):
    def test_render_item(self):
        notes = [dict(note(p, 0, 4, 70), bar=1, beat=1.0) for p in (48, 52, 55)]
        notes += [dict(note(76, 2, 1, 90), bar=1, beat=3.0)]
        item = {"track": "Piano", "start_bar": 1, "end_bar": 1, "timesig": [4, 4], "tempo": 92, "bars": [bar(1)],
                "notes": notes, "cc": [{"type": "cc", "cc": 64, "val": 127, "start": 0, "bar": 1, "beat": 1.0, "ch": 1}]}
        out = ra.render_item(item)
        self.assertIn("## Piano", out)
        self.assertIn("92 BPM", out)
        key_line = next(l for l in out.splitlines() if l.startswith("key (推定)"))
        self.assertIn("C major", key_line)
        self.assertIn("1| C", out)
        self.assertIn("C3(4) E3(4) G3(4)  v70", out)
        self.assertIn("3      E5(1)  v90", out)
        self.assertIn("pedal v1", out)
        self.assertIn("C4=60", out)
        summary = ra.render_item(item, detail=False)
        self.assertNotIn("C3(4)", summary)

    def test_render_empty(self):
        self.assertIn("ノートなし", ra.render_item({"track": "x", "notes": []}))


class DocExamplesTest(unittest.TestCase):
    """SKILL.md と references の JSON の例が、そのまま write に渡せること。"""

    def test_json_examples_are_valid_parts(self):
        import re
        found = 0
        for doc in [SKILL_DIR / "SKILL.md"] + sorted((SKILL_DIR / "references").glob("*.md")):
            for block in re.findall(r"```json\n(.*?)```", doc.read_text(encoding="utf-8"), re.S):
                data = json.loads(block)
                parts, common = ra.load_parts(data)
                meter = ra.meter_from_doc(common or parts[0])
                for p in parts:
                    item = ra.part_to_item(ra.normalize_part(p), meter)
                    self.assertTrue(item["notes"], doc.name)
                found += 1
        self.assertGreaterEqual(found, 2)

    def test_drum_names_in_reference_match_the_code(self):
        import re
        text = (SKILL_DIR / "references" / "gm.md").read_text(encoding="utf-8")
        rows = re.findall(r"^\| (`[^|]+`) \| ([\d / ]+) \|", text, re.M)
        self.assertGreater(len(rows), 20)
        for names_cell, numbers_cell in rows:
            names = re.findall(r"`([a-z_0-9]+)`", names_cell)
            numbers = [int(x) for x in re.findall(r"\d+", numbers_cell)]
            for i, name in enumerate(names):
                self.assertIn(name, ra.GM_DRUMS, name)
                # "a / b | 76 / 77" は対応づけ、"a / b | 36" は同じ番号
                expected = numbers[i] if len(numbers) == len(names) else numbers[0]
                self.assertEqual(ra.GM_DRUMS[name], expected, name)


def run_cli(*argv):
    out, err = io.StringIO(), io.StringIO()
    with redirect_stdout(out), redirect_stderr(err):
        code = ra.main(list(argv))
    return code, out.getvalue(), err.getvalue()


class NoBridgeTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self._base = ra.BASE_DIR
        ra.BASE_DIR = self.tmp

    def tearDown(self):
        ra.BASE_DIR = self._base
        shutil.rmtree(self.tmp)

    def test_status_without_bridge(self):
        code, out, _ = run_cli("status")
        self.assertEqual(code, ra.EXIT_NO_BRIDGE)
        self.assertIn("ai_bridge.lua", out)

    def test_call_without_bridge_fails_fast(self):
        start = time.time()
        code, _, err = run_cli("project")
        self.assertEqual(code, ra.EXIT_NO_BRIDGE)
        self.assertLess(time.time() - start, 1)
        self.assertIn("動いていません", err)

    def test_stale_heartbeat_counts_as_not_running(self):
        hb = ra.bridge_dirs(self.tmp)["heartbeat"]
        hb.parent.mkdir(parents=True)
        hb.write_text(json.dumps({"time": time.time() - 60}))
        code, _, _ = run_cli("project")
        self.assertEqual(code, ra.EXIT_NO_BRIDGE)

    def test_timeout_removes_unprocessed_request(self):
        hb = ra.bridge_dirs(self.tmp)["heartbeat"]
        hb.parent.mkdir(parents=True)
        hb.write_text(json.dumps({"time": time.time()}))
        with self.assertRaises(ra.BridgeError) as cm:
            ra.call("ping", timeout=0.3, base=self.tmp)
        self.assertEqual(cm.exception.code, ra.EXIT_NO_BRIDGE)
        self.assertEqual(list(ra.bridge_dirs(self.tmp)["inbox"].glob("*.json")), [])

    def test_view_and_mid_work_offline(self):
        part = {"track": "Bass (AI)", "timesig": [4, 4], "tempo": 100, "program": 33,
                "notes": [{"bar": 1, "len": 2, "pitch": "C2"}, {"bar": 1, "beat": 3, "len": 2, "pitch": "G1"},
                          {"bar": 2, "len": 4, "pitch": "A1"}]}
        src = self.tmp / "bass.json"
        src.write_text(json.dumps(part), encoding="utf-8")
        code, out, err = run_cli("view", str(src))
        self.assertEqual(code, 0, err)
        self.assertIn("C2(2)", out)
        mid = self.tmp / "bass.mid"
        code, out, err = run_cli("mid", str(src), str(mid))
        self.assertEqual(code, 0, err)
        code, out, err = run_cli("view", str(mid), "--bars", "2")
        self.assertEqual(code, 0, err)
        self.assertIn("A1(4)", out)
        self.assertNotIn("C2(2)", out)
        self.assertIn("100 BPM", out)

    def test_write_dry_run_needs_no_bridge(self):
        src = self.tmp / "p.json"
        src.write_text(json.dumps({"parts": [{"track": "Drums (AI)", "notes": [{"bar": 1, "len": 0.25, "pitch": "kick", "ch": 10}]}]}))
        code, out, err = run_cli("write", str(src), "--dry-run")
        self.assertEqual(code, 0, err)
        self.assertIn("Drums (AI)", out)

    def test_bad_input_is_a_usage_error(self):
        src = self.tmp / "bad.json"
        src.write_text(json.dumps({"track": "x", "notes": [{"bar": 1, "len": 1, "pitch": "Q4"}]}))
        code, _, err = run_cli("write", str(src))
        self.assertEqual(code, ra.EXIT_USAGE)
        self.assertIn("Q4", err)


@unittest.skipUnless(LUA, "lua5.4 がないので統合テストを省略")
class IntegrationTest(unittest.TestCase):
    """モックの REAPER 上で本物の ai_bridge.lua を常駐させ、CLI を subprocess で叩く。"""

    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp())
        cls.proc = subprocess.Popen([LUA, str(SKILL_DIR / "tests/lua/serve_mock.lua"), str(SKILL_DIR), str(cls.tmp), "120"],
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        deadline = time.time() + 10
        while time.time() < deadline and ra.heartbeat_age(cls.tmp) is None:
            time.sleep(0.05)

    @classmethod
    def tearDownClass(cls):
        (cls.tmp / "stop").write_text("")
        try:
            cls.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            cls.proc.kill()
        shutil.rmtree(cls.tmp)

    def cli(self, *argv):
        env = dict(os.environ, REAPER_AI_DIR=str(self.tmp))
        p = subprocess.run([sys.executable, str(SKILL_DIR / "scripts/reaper_ai.py")] + list(argv),
                           env=env, capture_output=True, text=True, timeout=60)
        return p.returncode, p.stdout, p.stderr

    def test_01_status_and_selftest(self):
        code, out, err = self.cli("status")
        self.assertEqual(code, 0, err + out)
        self.assertIn("project: Demo.rpp", out)
        code, out, err = self.cli("selftest")
        self.assertEqual(code, 0, err + out)
        self.assertIn("selftest: OK", out)

    def test_02_project(self):
        code, out, err = self.cli("project")
        self.assertEqual(code, 0, err)
        self.assertIn("Demo.rpp", out)
        self.assertIn("Piano", out)
        self.assertIn("bar 9", out)  # 拍子の変化
        self.assertIn("選択中のアイテム: 1", out)

    def test_03_read_selected(self):
        code, out, err = self.cli("read")
        self.assertEqual(code, 0, err)
        self.assertIn("## Piano", out)
        self.assertIn("1| C", out)
        self.assertIn("2| Am7", out)
        self.assertIn("3| Fmaj7", out)
        self.assertIn("4| G7", out)
        self.assertIn("pedal v1", out)
        code, out, err = self.cli("read", "--track", "Piano", "--json")
        self.assertEqual(code, 0, err)
        data = json.loads(out)
        self.assertEqual(len(data["items"][0]["notes"]), 19)

    def test_04_write_then_read_back(self):
        part = {"parts": [
            {"track": "Bass v1 (AI)", "after": "Piano", "program": 33, "instrument": "AUi: DLSMusicDevice (Apple)",
             "notes": [{"bar": b, "beat": 1, "len": 3.5, "pitch": p, "vel": 92} for b, p in ((1, "C2"), (2, "A1"), (3, "F1"), (4, "G1"))]},
            {"track": "Drums v1 (AI)", "instrument": "AUi: DLSMusicDevice (Apple)",
             "notes": [{"bar": b, "beat": bt, "len": 0.25, "pitch": "kick" if bt in (1, 3) else "snare", "ch": 10}
                       for b in range(1, 5) for bt in (1, 2, 3, 4)]},
        ]}
        src = self.tmp / "parts.json"
        src.write_text(json.dumps(part, ensure_ascii=False), encoding="utf-8")
        code, out, err = self.cli("write", str(src))
        self.assertEqual(code, 0, err + out)
        self.assertIn("wrote: Bass v1 (AI) (track 2, 新規トラック) bars 1-4  notes 4", out)
        self.assertIn("wrote: Drums v1 (AI)", out)
        self.assertIn("instrument: AUi: DLSMusicDevice (Apple)", out)
        code, out, err = self.cli("read", "--track", "Bass v1 (AI)", "--json")
        self.assertEqual(code, 0, err)
        notes = json.loads(out)["items"][0]["notes"]
        self.assertEqual([(n["name"], n["bar"], n["beat"], n["len"]) for n in notes],
                         [("C2", 1, 1, 3.5), ("A1", 2, 1, 3.5), ("F1", 3, 1, 3.5), ("G1", 4, 1, 3.5)])
        code, out, err = self.cli("project")
        self.assertIn("Bass v1 (AI)", out)
        self.assertIn("[AI]", out)

    def test_05_write_in_three_four_section(self):
        src = self.tmp / "waltz.json"
        src.write_text(json.dumps({"track": "Waltz (AI)", "notes": [{"bar": 9, "beat": b, "len": 1, "pitch": "C4"} for b in (1, 2, 3)] +
                                   [{"bar": 10, "beat": 1, "len": 3, "pitch": "E4"}]}))
        code, out, err = self.cli("write", str(src))
        self.assertEqual(code, 0, err + out)
        self.assertIn("bars 9-10", out)
        code, out, err = self.cli("read", "--track", "Waltz (AI)", "--json")
        notes = json.loads(out)["items"][0]["notes"]
        self.assertEqual([n["start"] for n in notes], [32, 33, 34, 35])
        self.assertEqual(json.loads(out)["items"][0]["timesig"], [3, 4])

    def test_06_errors_come_back_as_messages(self):
        code, _, err = self.cli("read", "--track", "Nope")
        self.assertEqual(code, ra.EXIT_OP_ERROR)
        self.assertIn("トラックが見つかりません", err)
        code, _, err = self.cli("call", "explode")
        self.assertEqual(code, ra.EXIT_OP_ERROR)
        self.assertIn("未知の op", err)
        code, _, err = self.cli("track", "Piano", "--delete")
        self.assertEqual(code, ra.EXIT_OP_ERROR)
        self.assertIn("削除しません", err)

    def test_07_transport_markers_fx_lua(self):
        code, out, err = self.cli("play", "--bar", "3")
        self.assertEqual(code, 0, err)
        self.assertIn("bar 3", out)
        self.assertEqual(self.cli("stop")[0], 0)
        code, out, err = self.cli("markers", "--region", "Aメロ:1-4", "--marker", "brk:3")
        self.assertEqual(code, 0, err)
        code, out, err = self.cli("project")
        self.assertIn("[region] Aメロ", out)
        code, out, err = self.cli("fx", "--instruments")
        self.assertEqual(code, 0, err)
        self.assertIn("DLSMusicDevice", out)
        code, out, err = self.cli("lua", "-e", "print('n', reaper.CountTracks(0)); return 42")
        self.assertEqual(code, 0, err)
        self.assertIn("42", out)

    def test_08_track_ops(self):
        src = self.tmp / "tmp.json"
        src.write_text(json.dumps({"track": "Scratch (AI)", "notes": [{"bar": 1, "len": 1, "pitch": 60}]}))
        self.assertEqual(self.cli("write", str(src))[0], 0)
        code, out, err = self.cli("track", "Scratch (AI)", "--mute", "--volume", "-6")
        self.assertEqual(code, 0, err)
        self.assertEqual(json.loads(out)["mute"], True)
        code, out, err = self.cli("track", "Scratch (AI)", "--delete")
        self.assertEqual(code, 0, err)


if __name__ == "__main__":
    unittest.main()
