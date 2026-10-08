"""install.py のテスト。HOME などを一時ディレクトリに向けて実ファイルを書かせる。

  python3 -m unittest discover -s herdr-vsd-deck/tests/install
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
INSTALL = ROOT / "install.py"
sys.path.insert(0, str(ROOT))
import install  # noqa: E402

PLUGIN = "com.kuruusuniku.herdr-deck.sdPlugin"


class InstallTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        self.claude = self.home / ".claude"
        self.plugins = self.home / "plugins"
        self.env = {
            **os.environ,
            "HOME": str(self.home),
            "USERPROFILE": str(self.home),
            "CLAUDE_CONFIG_DIR": str(self.claude),
        }
        self.env.pop("HERDR_VSD_DECK_CONFIG", None)

    def run_install(self, *args: str) -> subprocess.CompletedProcess:
        return subprocess.run(
            [sys.executable, str(INSTALL), "--plugins-dir", str(self.plugins), *args],
            env=self.env, capture_output=True, text=True, timeout=60, check=False,
        )

    def settings(self) -> dict:
        return json.loads((self.claude / "settings.json").read_text(encoding="utf-8"))

    def our_commands(self, event: str) -> list[str]:
        return [h["command"] for g in self.settings()["hooks"].get(event, []) for h in g["hooks"] if "zunda_notify.py" in h["command"]]

    def test_fresh_install(self):
        done = self.run_install()
        self.assertEqual(done.returncode, 0, done.stderr)
        manifest = self.plugins / PLUGIN / "manifest.json"
        self.assertEqual(json.loads(manifest.read_text(encoding="utf-8"))["CodePathMac"], "plugin/index.js")
        self.assertTrue((self.plugins / PLUGIN / "plugin" / "index.js").exists())
        self.assertFalse((self.plugins / PLUGIN / "plugin" / "log").exists())
        hook = self.claude / "hooks" / "herdr-vsd-deck" / "zunda_notify.py"
        self.assertTrue(hook.exists())
        for event in ("Stop", "Notification"):
            commands = self.our_commands(event)
            self.assertEqual(len(commands), 1)
            self.assertIn(hook.as_posix(), commands[0])
        stop = self.settings()["hooks"]["Stop"][0]["hooks"][0]
        self.assertTrue(stop["async"])
        config = self.home / ".config" / "herdr-vsd-deck" / "config.json"
        self.assertEqual(json.loads(config.read_text(encoding="utf-8"))["voice"]["speaker"], 3)

    def test_existing_settings_are_kept_and_reinstall_is_idempotent(self):
        self.claude.mkdir(parents=True)
        original = {
            "model": "opus",
            "hooks": {
                "Stop": [{"hooks": [{"type": "command", "command": "afplay done.aiff"}]}],
                "PreToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", "command": "guard.sh"}]}],
            },
        }
        (self.claude / "settings.json").write_text(json.dumps(original), encoding="utf-8")
        config = self.home / ".config" / "herdr-vsd-deck" / "config.json"
        config.parent.mkdir(parents=True)
        config.write_text('{"voice": {"speaker": 1}}', encoding="utf-8")

        for _ in range(2):
            done = self.run_install()
            self.assertEqual(done.returncode, 0, done.stderr)
        settings = self.settings()
        self.assertEqual(settings["model"], "opus")
        self.assertEqual(settings["hooks"]["PreToolUse"], original["hooks"]["PreToolUse"])
        self.assertIn({"hooks": [{"type": "command", "command": "afplay done.aiff"}]}, settings["hooks"]["Stop"])
        self.assertEqual(len(self.our_commands("Stop")), 1)
        self.assertEqual(len(self.our_commands("Notification")), 1)
        self.assertTrue(list(self.claude.glob("settings.json.bak-herdr-vsd-deck-*")))
        self.assertEqual(config.read_text(encoding="utf-8"), '{"voice": {"speaker": 1}}', "config is never overwritten")

    def test_broken_settings_are_not_touched(self):
        self.claude.mkdir(parents=True)
        (self.claude / "settings.json").write_text("{ not json", encoding="utf-8")
        done = self.run_install("--skip-plugin")
        self.assertNotEqual(done.returncode, 0)
        self.assertIn("JSON として読めない", done.stderr)
        self.assertEqual((self.claude / "settings.json").read_text(encoding="utf-8"), "{ not json")

    def test_uninstall_removes_only_our_parts(self):
        self.claude.mkdir(parents=True)
        (self.claude / "settings.json").write_text(json.dumps({"hooks": {"Stop": [{"hooks": [{"type": "command", "command": "mine.sh"}]}]}}), encoding="utf-8")
        self.assertEqual(self.run_install().returncode, 0)
        done = self.run_install("--uninstall")
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertFalse((self.plugins / PLUGIN).exists())
        self.assertFalse((self.claude / "hooks" / "herdr-vsd-deck").exists())
        self.assertEqual(self.settings()["hooks"], {"Stop": [{"hooks": [{"type": "command", "command": "mine.sh"}]}]})
        self.assertTrue((self.home / ".config" / "herdr-vsd-deck" / "config.json").exists())

    def test_plugins_dir_detection(self):
        with mock.patch.dict(os.environ, {"HOME": str(self.home)}):
            with self.assertRaises(SystemExit) as ctx:
                install.plugins_dir(None, "Darwin")
            self.assertIn("VSD Craft のデータフォルダが見つかりません", str(ctx.exception))
            base = self.home / "Library" / "Application Support" / "HotSpot" / "StreamDock"
            base.mkdir(parents=True)
            self.assertEqual(install.plugins_dir(None, "Darwin"), base / "plugins")
            (base / "Plugins").mkdir()
            self.assertEqual(install.plugins_dir(None, "Darwin"), base / "Plugins")
        with mock.patch.dict(os.environ, {"APPDATA": str(self.home / "Roaming")}):
            (self.home / "Roaming" / "HotSpot" / "StreamDock" / "plugins").mkdir(parents=True)
            self.assertEqual(install.plugins_dir(None, "Windows"), self.home / "Roaming" / "HotSpot" / "StreamDock" / "plugins")
        with self.assertRaises(SystemExit):
            install.plugins_dir(None, "Linux")

    def test_hook_command_quotes_paths(self):
        self.assertEqual(
            install.hook_command("C:\\Python312\\python.exe", Path("/Users/me/.claude/hooks/herdr-vsd-deck/zunda_notify.py")),
            '"C:\\Python312\\python.exe" "/Users/me/.claude/hooks/herdr-vsd-deck/zunda_notify.py"' if os.name != "nt" else
            '"C:/Python312/python.exe" "/Users/me/.claude/hooks/herdr-vsd-deck/zunda_notify.py"',
        )


if __name__ == "__main__":
    unittest.main()
