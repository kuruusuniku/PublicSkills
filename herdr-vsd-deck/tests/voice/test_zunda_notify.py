"""zunda_notify.py のテスト。VOICEVOX / Ollama / OpenAI 互換 API は偽サーバで代用する。

  python3 -m unittest discover -s herdr-vsd-deck/tests/voice
"""

from __future__ import annotations

import io
import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
from contextlib import redirect_stdout
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "voice" / "zunda_notify.py"
FIXTURES = Path(__file__).resolve().parent / "fixtures"
FAKE_HERDR = ROOT / "tests" / "plugin" / "fixtures" / "fake-herdr.js"
SNAPSHOT = ROOT / "tests" / "plugin" / "fixtures" / "snapshot.json"
TRANSCRIPT = FIXTURES / "transcript.jsonl"

sys.path.insert(0, str(SCRIPT.parent))
import zunda_notify as zn  # noqa: E402

FAKE_WAV = b"RIFF\x24\x00\x00\x00WAVEfmt " + b"\x00" * 28


class FakeServers:
    """VOICEVOX (/version, /audio_query, /synthesis) と LLM (/api/chat, /v1/chat/completions) を1つで真似る。"""

    def __init__(self):
        self.requests: list[tuple[str, dict, object]] = []
        self.llm_reply = "apiの認証まわりの修正が終わったのだ。テスト結果を確認してほしいのだ。"
        self.reject_think = False
        self.llm_down = False
        servers = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def reply(self, code: int, body: bytes, ctype: str = "application/json"):
                self.send_response(code)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):
                if self.path == "/version":
                    self.reply(200, b'"0.99.0"')
                else:
                    self.reply(404, b"{}")

            def do_POST(self):
                url = urlparse(self.path)
                query = {k: v[0] for k, v in parse_qs(url.query).items()}
                raw = self.rfile.read(int(self.headers.get("Content-Length") or 0))
                body = json.loads(raw) if raw else None
                servers.requests.append((url.path, query, body))
                if url.path == "/audio_query":
                    self.reply(200, json.dumps({"accent_phrases": [], "speedScale": 1.0, "volumeScale": 1.0, "kana": query.get("text")}).encode())
                elif url.path == "/synthesis":
                    self.reply(200, FAKE_WAV, "audio/wav")
                elif url.path == "/api/chat":
                    if servers.llm_down:
                        self.reply(500, b'{"error":"down"}')
                    elif servers.reject_think and "think" in body:
                        self.reply(400, b'{"error":"model does not support thinking"}')
                    else:
                        self.reply(200, json.dumps({"message": {"role": "assistant", "content": servers.llm_reply}}).encode())
                elif url.path == "/v1/chat/completions":
                    self.reply(200, json.dumps({"choices": [{"message": {"content": servers.llm_reply}}]}).encode())
                else:
                    self.reply(404, b"{}")

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        threading.Thread(target=self.httpd.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True).start()

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()

    def paths(self) -> list[str]:
        return [p for p, _, _ in self.requests]


class VoiceTestCase(unittest.TestCase):
    def setUp(self):
        self.servers = FakeServers()
        self.addCleanup(self.servers.close)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.config_file = Path(self.tmp.name) / "config.json"
        self.write_config()
        env = {"HERDR_VSD_DECK_CONFIG": str(self.config_file), "FAKE_HERDR_SNAPSHOT": str(SNAPSHOT)}
        patcher = mock.patch.dict(os.environ, env)
        patcher.start()
        self.addCleanup(patcher.stop)
        os.environ.pop("HERDR_WORKSPACE_ID", None)

    def write_config(self, **voice_overrides):
        voice = {
            "voicevoxUrl": self.servers.url,
            "speedScale": 1.3,
            "llm": {"provider": "ollama", "url": self.servers.url, "model": "test-model", "timeoutSec": 5},
        }
        voice.update(voice_overrides)
        self.config_file.write_text(json.dumps({"herdr": {"bin": str(FAKE_HERDR)}, "voice": voice}), encoding="utf-8")


class ClassifyTest(unittest.TestCase):
    def test_events(self):
        self.assertEqual(zn.classify({"hook_event_name": "Stop", "stop_hook_active": False}), "stop")
        self.assertIsNone(zn.classify({"hook_event_name": "Stop", "stop_hook_active": True}))
        self.assertEqual(zn.classify({"hook_event_name": "Notification", "notification_type": "permission_prompt"}), "permission")
        self.assertEqual(zn.classify({"hook_event_name": "Notification", "notification_type": "elicitation_dialog"}), "question")
        self.assertEqual(zn.classify({"hook_event_name": "Notification", "notification_type": "idle_prompt"}), "idle")
        self.assertIsNone(zn.classify({"hook_event_name": "Notification", "notification_type": "auth_success"}))
        self.assertIsNone(zn.classify({"hook_event_name": "PreToolUse"}))

    def test_old_notification_without_type(self):
        hook = {"hook_event_name": "Notification", "message": "Claude needs your permission to use Bash"}
        self.assertEqual(zn.classify(hook), "permission")


class TextTest(unittest.TestCase):
    def test_sanitize_strips_markup_and_thinking(self):
        raw = "<think>考え中…</think>\n「**api**の作業が`終わった`のだ。」\nhttps://example.com 確認してほしいのだ。"
        self.assertEqual(zn.sanitize(raw, 90), "apiの作業が終わったのだ。確認してほしいのだ。")
        self.assertEqual(zn.sanitize("直したのだ。\n```\nrm -rf /\n```\n確認してほしいのだ。", 90), "直したのだ。確認してほしいのだ。")

    def test_sanitize_unterminated_think(self):
        self.assertEqual(zn.sanitize("<think>ずっと考えている", 90), "")

    def test_sanitize_cuts_at_sentence(self):
        text = "一文目はここまでなのだ。" + "あ" * 100
        self.assertEqual(zn.sanitize(text, 40), "一文目はここまでなのだ。")

    def test_last_assistant_text_prefers_hook_field(self):
        entries = zn.read_transcript_tail(str(TRANSCRIPT))
        self.assertEqual(zn.last_assistant_text({"last_assistant_message": " 完了しました "}, entries), "完了しました")
        self.assertEqual(zn.last_assistant_text({}, entries), "テストを実行して確認します。")

    def test_pending_tool_from_transcript(self):
        entries = zn.read_transcript_tail(str(TRANSCRIPT))
        self.assertEqual(zn.pending_tool(entries), "Bash: Run auth tests")

    def test_missing_transcript_is_empty(self):
        self.assertEqual(zn.read_transcript_tail("/nonexistent/x.jsonl"), [])

    def test_powershell_commands_are_encoded(self):
        import base64
        cmd = zn.powershell("Speak(" + zn.ps_quote("it's ずんだもん") + ")")
        self.assertEqual(cmd[:4], ["powershell", "-NoProfile", "-NonInteractive", "-EncodedCommand"])
        self.assertEqual(base64.b64decode(cmd[4]).decode("utf-16-le"), "Speak('it''s ずんだもん')")


class PlaceTest(VoiceTestCase):
    def test_uses_herdr_workspace_label(self):
        os.environ["HERDR_WORKSPACE_ID"] = "w2"
        self.assertEqual(zn.place_name({"cwd": "/Users/me/src/web"}, zn.load_config()), "フロント")

    def test_falls_back_to_cwd_folder(self):
        self.assertEqual(zn.place_name({"cwd": "/Users/me/src/web/"}, zn.load_config()), "web")
        os.environ["HERDR_WORKSPACE_ID"] = "w404"
        self.assertEqual(zn.place_name({"cwd": "C:\\Users\\me\\proj"}, zn.load_config()), "proj")


class ComposeTest(VoiceTestCase):
    def test_llm_reply_is_used(self):
        voice = zn.load_config()["voice"]
        text = zn.compose("stop", "api", "認証ミドルウェアを直しました", voice)
        self.assertEqual(text, self.servers.llm_reply)
        _, _, body = self.servers.requests[-1]
        self.assertEqual(body["model"], "test-model")
        self.assertFalse(body["stream"])
        self.assertIn("場所: api", body["messages"][1]["content"])
        self.assertIn("認証ミドルウェアを直しました", body["messages"][1]["content"])

    def test_retries_without_think_for_old_ollama(self):
        self.servers.reject_think = True
        text = zn.compose("stop", "api", "done", zn.load_config()["voice"])
        self.assertEqual(text, self.servers.llm_reply)
        self.assertEqual(self.servers.paths().count("/api/chat"), 2)

    def test_fallback_when_llm_down(self):
        self.servers.llm_down = True
        text = zn.compose("permission", "フロント", "", zn.load_config()["voice"])
        self.assertEqual(text, "フロントで許可待ちなのだ。内容を確認してほしいのだ。")

    def test_fallback_when_reply_is_not_zundamon(self):
        self.servers.llm_reply = "Task completed successfully."
        self.assertEqual(zn.compose("stop", "api", "", zn.load_config()["voice"]), "apiの作業が終わったのだ。結果を確認してほしいのだ。")

    def test_openai_compatible_provider(self):
        self.write_config(llm={"provider": "openai", "url": self.servers.url, "model": "local"})
        self.assertEqual(zn.compose("stop", "api", "", zn.load_config()["voice"]), self.servers.llm_reply)
        self.assertIn("/v1/chat/completions", self.servers.paths())

    def test_provider_none_uses_template_without_network(self):
        self.write_config(llm={"provider": "none"})
        self.assertEqual(zn.compose("question", "docs", "", zn.load_config()["voice"]), "docsから質問が来てるのだ。答えてあげてほしいのだ。")
        self.assertEqual(self.servers.requests, [])


class SpeakTest(VoiceTestCase):
    def test_voicevox_request_and_playback(self):
        played = Path(self.tmp.name) / "played.wav"
        copier = [sys.executable, "-c", f"import shutil,sys; shutil.copy(sys.argv[1], {str(played)!r})"]
        with mock.patch.object(zn, "player_command", lambda path: [*copier, path]):
            used = zn.speak(zn.load_config()["voice"], "テストなのだ")
        self.assertEqual(used, "voicevox")
        self.assertEqual(played.read_bytes(), FAKE_WAV)
        (_, q1, _), (_, q2, body) = self.servers.requests
        self.assertEqual(q1, {"text": "テストなのだ", "speaker": "3"})
        self.assertEqual(q2, {"speaker": "3"})
        self.assertEqual(body["speedScale"], 1.3)

    def test_os_tts_fallback_when_voicevox_down(self):
        self.write_config(voicevoxUrl="http://127.0.0.1:9")
        with mock.patch.object(zn, "os_tts_command", lambda text: [sys.executable, "-c", "pass"]):
            self.assertEqual(zn.speak(zn.load_config()["voice"], "テスト"), "os")
        self.write_config(voicevoxUrl="http://127.0.0.1:9", fallbackTts=False)
        self.assertEqual(zn.speak(zn.load_config()["voice"], "テスト"), "none")

    def test_stale_lock_is_taken_over(self):
        lock = zn.PlaybackLock(wait_sec=1)
        lock.path.write_text("12345")
        old = lock.path.stat().st_mtime - 3600
        os.utime(lock.path, (old, old))
        with lock:
            self.assertTrue(lock.held)
        self.assertFalse(lock.path.exists())


class MainTest(VoiceTestCase):
    def run_script(self, hook: dict, *args: str, env: dict | None = None) -> subprocess.CompletedProcess:
        return subprocess.run(
            [sys.executable, str(SCRIPT), *args],
            input=json.dumps(hook), capture_output=True, text=True, timeout=30,
            env={**os.environ, **(env or {})}, check=False,
        )

    def test_dry_run_stop_hook(self):
        hook = {"hook_event_name": "Stop", "stop_hook_active": False, "cwd": "/x/api", "last_assistant_message": "直しました"}
        done = self.run_script(hook, "--dry-run", env={"HERDR_WORKSPACE_ID": "w1"})
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(done.stdout.strip(), self.servers.llm_reply)
        self.assertIn("場所: api", self.servers.requests[-1][2]["messages"][1]["content"])

    def test_permission_hook_reads_pending_tool(self):
        hook = {
            "hook_event_name": "Notification", "notification_type": "permission_prompt",
            "message": "Claude needs your permission to use Bash", "cwd": "/x/web", "transcript_path": str(TRANSCRIPT),
        }
        done = self.run_script(hook, "--dry-run")
        self.assertEqual(done.returncode, 0, done.stderr)
        prompt = self.servers.requests[-1][2]["messages"][1]["content"]
        self.assertIn("Bash: Run auth tests", prompt)
        self.assertIn("テストを実行して確認します。", prompt)

    def test_disabled_events_and_mute_are_silent(self):
        idle = {"hook_event_name": "Notification", "notification_type": "idle_prompt", "cwd": "/x/api"}
        self.assertEqual(self.run_script(idle, "--dry-run").stdout, "")
        stop = {"hook_event_name": "Stop", "cwd": "/x/api"}
        self.assertEqual(self.run_script(stop, "--dry-run", env={"HERDR_VSD_DECK_MUTE": "1"}).stdout, "")
        self.assertEqual(self.servers.requests, [])

    def test_garbage_input_never_fails(self):
        done = subprocess.run([sys.executable, str(SCRIPT)], input="not json", capture_output=True, text=True, timeout=30, check=False)
        self.assertEqual(done.returncode, 0)

    def test_check_reports_status(self):
        out = io.StringIO()
        with redirect_stdout(out):
            code = zn.main(["--check"])
        self.assertEqual(code, 0, out.getvalue())
        self.assertIn("VOICEVOX: OK", out.getvalue())
        self.assertIn("LLM: OK", out.getvalue())


if __name__ == "__main__":
    unittest.main()
