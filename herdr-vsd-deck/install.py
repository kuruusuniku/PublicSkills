#!/usr/bin/env python3
"""herdr-vsd-deck のインストーラ (macOS / Windows)。

  1. VSD Craft (Mirabox Stream Dock) のプラグインフォルダへ herdr Deck プラグインをコピー
  2. ずんだもん読み上げフックを ~/.claude/hooks/herdr-vsd-deck/ に置き、
     ~/.claude/settings.json の Stop / Notification フックに登録 (元ファイルはバックアップ)
  3. 設定ファイル ~/.config/herdr-vsd-deck/config.json が無ければ雛形を作る (既存は上書きしない)

  python3 install.py                 # 全部入れる
  python3 install.py --skip-voice    # キー表示だけ
  python3 install.py --skip-plugin   # 読み上げだけ
  python3 install.py --uninstall     # 取り除く (config.json は残す)
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import shutil
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
PLUGIN_NAME = "com.kuruusuniku.herdr-deck.sdPlugin"
PLUGIN_SRC = HERE / "plugin" / PLUGIN_NAME
HOOK_SRC = HERE / "voice" / "zunda_notify.py"
CONFIG_EXAMPLE = HERE / "config.example.json"
HOOK_MARKER = "herdr-vsd-deck/zunda_notify.py"


def home() -> Path:
    return Path(os.environ.get("HOME") or os.environ.get("USERPROFILE") or Path.home())


def streamdock_dir(system: str | None = None) -> Path | None:
    """VSD Craft (StreamDock) のデータフォルダ。"""
    system = system or platform.system()
    if system == "Darwin":
        return home() / "Library" / "Application Support" / "HotSpot" / "StreamDock"
    if system == "Windows":
        appdata = os.environ.get("APPDATA") or str(home() / "AppData" / "Roaming")
        return Path(appdata) / "HotSpot" / "StreamDock"
    return None


def plugins_dir(override: str | None, system: str | None = None) -> Path:
    if override:
        return Path(override).expanduser()
    base = streamdock_dir(system)
    if base is None:
        raise SystemExit("VSD Craft は macOS / Windows 用です。--plugins-dir でプラグインフォルダを指定してください。")
    for name in ("plugins", "Plugins"):
        if (base / name).is_dir():
            return base / name
    if base.is_dir():
        return base / "plugins"
    raise SystemExit(
        f"VSD Craft のデータフォルダが見つかりません: {base}\n"
        "VSD Craft を一度起動してから再実行するか、VSD Craft の 設定 → 一般 →「アプリケーションフォルダを開く」で\n"
        "plugins フォルダを確認して --plugins-dir で指定してください。"
    )


def claude_dir() -> Path:
    return Path(os.environ["CLAUDE_CONFIG_DIR"]) if os.environ.get("CLAUDE_CONFIG_DIR") else home() / ".claude"


def config_file() -> Path:
    if os.environ.get("HERDR_VSD_DECK_CONFIG"):
        return Path(os.environ["HERDR_VSD_DECK_CONFIG"])
    return home() / ".config" / "herdr-vsd-deck" / "config.json"


def hook_path() -> Path:
    return claude_dir() / "hooks" / "herdr-vsd-deck" / "zunda_notify.py"


def hook_command(python: str, script: Path) -> str:
    # bash でも cmd でも通るよう、Windows のパスも / 区切りにして引用符で囲む
    return f'"{Path(python).as_posix()}" "{script.as_posix()}"'


def install_plugin(dest_root: Path) -> Path:
    dest = dest_root / PLUGIN_NAME
    if dest.exists():
        shutil.rmtree(dest)
    dest_root.mkdir(parents=True, exist_ok=True)
    shutil.copytree(PLUGIN_SRC, dest, ignore=shutil.ignore_patterns("log", "*.log", "__pycache__"))
    return dest


def strip_our_hooks(groups: list) -> list:
    kept = []
    for group in groups:
        if not isinstance(group, dict):
            kept.append(group)
            continue
        hooks = [h for h in group.get("hooks", []) if HOOK_MARKER not in str(h.get("command", "")).replace("\\", "/")]
        if hooks:
            kept.append({**group, "hooks": hooks})
        elif not group.get("hooks"):
            kept.append(group)
    return kept


def load_settings(path: Path) -> dict:
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8") or "{}")
    except ValueError as err:
        raise SystemExit(f"{path} が JSON として読めないので変更しません: {err}")
    if not isinstance(data, dict):
        raise SystemExit(f"{path} の形式が想定外なので変更しません")
    return data


def write_settings(path: Path, data: dict) -> Path | None:
    backup = None
    if path.exists():
        backup = path.with_name(f"{path.name}.bak-herdr-vsd-deck-{time.strftime('%Y%m%d-%H%M%S')}")
        shutil.copy2(path, backup)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, path)
    return backup


def register_hooks(settings_path: Path, command: str) -> Path | None:
    data = load_settings(settings_path)
    hooks = data.setdefault("hooks", {})
    entry = {"type": "command", "command": command, "async": True, "timeout": 120}
    for event in ("Stop", "Notification"):
        groups = strip_our_hooks(hooks.get(event, []))
        # Notification は matcher 無しで全種類を受け、読むかどうかは config の voice.events で決める
        groups.append({"hooks": [dict(entry)]})
        hooks[event] = groups
    return write_settings(settings_path, data)


def unregister_hooks(settings_path: Path) -> Path | None:
    if not settings_path.exists():
        return None
    data = load_settings(settings_path)
    hooks = data.get("hooks", {})
    changed = False
    for event in list(hooks):
        groups = strip_our_hooks(hooks[event])
        if groups != hooks[event]:
            changed = True
            if groups:
                hooks[event] = groups
            else:
                del hooks[event]
    return write_settings(settings_path, data) if changed else None


def install_voice(python: str) -> tuple[Path, Path | None]:
    dest = hook_path()
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(HOOK_SRC, dest)
    backup = register_hooks(claude_dir() / "settings.json", hook_command(python, dest))
    return dest, backup


def ensure_config() -> tuple[Path, bool]:
    path = config_file()
    if path.exists():
        return path, False
    path.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(CONFIG_EXAMPLE, path)
    return path, True


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="herdr-vsd-deck をインストールする")
    parser.add_argument("--plugins-dir", help="VSD Craft の plugins フォルダ (自動検出できない場合)")
    parser.add_argument("--skip-plugin", action="store_true", help="VSD Craft プラグインを入れない")
    parser.add_argument("--skip-voice", action="store_true", help="ずんだもん読み上げフックを入れない")
    parser.add_argument("--uninstall", action="store_true", help="プラグインとフックを取り除く")
    parser.add_argument("--python", default=sys.executable, help="フックを実行する Python (既定: このインストーラを動かした Python)")
    args = parser.parse_args(argv)

    if args.uninstall:
        if not args.skip_plugin:
            target = plugins_dir(args.plugins_dir) / PLUGIN_NAME
            if target.exists():
                shutil.rmtree(target)
                print(f"プラグインを削除しました: {target}")
        if not args.skip_voice:
            backup = unregister_hooks(claude_dir() / "settings.json")
            if backup:
                print(f"settings.json からフックを外しました (バックアップ: {backup})")
            if hook_path().exists():
                shutil.rmtree(hook_path().parent)
                print(f"フックを削除しました: {hook_path().parent}")
        print("設定ファイルは残しています:", config_file())
        return 0

    cfg, created = ensure_config()
    print(f"設定ファイル: {cfg}{' (新規作成)' if created else ' (既存のまま)'}")

    if not args.skip_plugin:
        dest = install_plugin(plugins_dir(args.plugins_dir))
        print(f"VSD Craft プラグインを配置しました: {dest}")

    if not args.skip_voice:
        hook, backup = install_voice(args.python)
        print(f"読み上げフックを配置しました: {hook}")
        print(f"Claude Code の Stop / Notification フックに登録しました: {claude_dir() / 'settings.json'}")
        if backup:
            print(f"  元の settings.json のバックアップ: {backup}")

    print(
        "\n次にやること:\n"
        "  1. VSD Craft を再起動し、アクション一覧の「herdr Deck」から\n"
        "     「herdr エージェント」を並べたいキーへ、「herdr サマリー」を1つ置く\n"
        "  2. herdr を起動して、その中で Claude Code を動かす (状態は herdr が画面から検出します)\n"
    )
    if not args.skip_voice:
        print(
            "  3. VOICEVOX を起動 (既定 http://127.0.0.1:50021)\n"
            "  4. ローカル LLM を用意: ollama pull gemma3:4b  (無くても定型文で読み上げます)\n"
            f"  5. 接続確認: {hook_command(args.python, hook_path())} --check\n"
            f"     試し読み: {hook_command(args.python, hook_path())} --say \"準備できたのだ\"\n"
            "  6. 実行中の Claude Code は /hooks を開くか再起動するとフックが有効になります\n"
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
