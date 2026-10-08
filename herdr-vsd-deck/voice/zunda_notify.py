#!/usr/bin/env python3
"""Claude Code のフックから呼ばれ、エージェントの状況をずんだもんの声で知らせる。

  Stop                         → 作業が終わった
  Notification (permission_prompt) → 許可待ちで止まっている
  Notification (elicitation_dialog) → 質問されている
  Notification (idle_prompt / agent_needs_input) → 入力待ち (既定では読み上げない)

流れ:
  1. フック入力 (stdin の JSON) から、どこで何が起きたかを判定する
     どこ = herdr のワークスペース名 (HERDR_WORKSPACE_ID から引く)。無ければ cwd のフォルダ名
  2. ローカル LLM (Ollama / OpenAI 互換 API) で「何が起きて、次に何をすればいいか」を
     ずんだもん口調の短い1〜2文にまとめる。LLM が無ければ定型文
  3. VOICEVOX で合成して再生する。VOICEVOX が無ければ OS の読み上げ (設定で無効化可)

標準ライブラリだけで動く。設定は ~/.config/herdr-vsd-deck/config.json の "voice"。

使い方:
  フック:   python3 zunda_notify.py            (stdin にフック入力)
  確認:     python3 zunda_notify.py --check    (VOICEVOX / LLM への接続を確認)
  試し読み: python3 zunda_notify.py --say "テストなのだ"
  文面だけ: python3 zunda_notify.py --dry-run < hook.json
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

DEFAULTS: dict = {
    "herdr": {"bin": "", "session": "", "socketPath": ""},
    "voice": {
        "enabled": True,
        "voicevoxUrl": "http://127.0.0.1:50021",
        "speaker": 3,  # ずんだもん (ノーマル)
        "speedScale": 1.15,
        "volumeScale": 1.0,
        "fallbackTts": True,
        "maxChars": 90,
        "events": {"stop": True, "permission": True, "question": True, "idle": False},
        "llm": {
            "provider": "ollama",  # ollama | openai | none
            "url": "http://127.0.0.1:11434",
            "model": "gemma3:4b",
            "apiKey": "",
            "timeoutSec": 25,
        },
    },
}

EVENT_DESCRIPTIONS = {
    "stop": "エージェントが作業を終えて、ユーザーの返事を待っている",
    "permission": "エージェントがツールの実行許可を求めて止まっている",
    "question": "エージェントがユーザーに質問していて、回答を待っている",
    "idle": "エージェントがしばらくユーザーの入力を待っている",
}

FALLBACK_TEMPLATES = {
    "stop": "{place}の作業が終わったのだ。結果を確認してほしいのだ。",
    "permission": "{place}で許可待ちなのだ。内容を確認してほしいのだ。",
    "question": "{place}から質問が来てるのだ。答えてあげてほしいのだ。",
    "idle": "{place}が入力を待ってるのだ。",
}

SYSTEM_PROMPT = """あなたは「ずんだもん」です。AIコーディングエージェントの状況を、開発者に音声で知らせる係をしています。

ルール:
- 出力は読み上げる文だけ。前置き、説明、かぎかっこ、箇条書き、Markdown、絵文字、URL、コードは書かない。
- 1〜2文、全体で{max_chars}文字以内。
- 語尾は「〜のだ」「〜なのだ」。
- 1文目は、どこ(場所の名前)で何が起きたか。2文目は、開発者が次にやるべきこと。
- ファイル名やコマンド名は、必要なときだけ短く言い換える。英単語の羅列は避ける。

例:
apiの認証まわりの修正が終わったのだ。テストが通ったか確認してほしいのだ。
フロントでコマンドの実行許可を待ってるのだ。内容を見て許可してほしいのだ。"""


# ---------------------------------------------------------------- 設定


def config_path() -> Path:
    override = os.environ.get("HERDR_VSD_DECK_CONFIG")
    if override:
        return Path(override)
    return Path.home() / ".config" / "herdr-vsd-deck" / "config.json"


def merge(base: dict, override: object) -> dict:
    out = dict(base)
    if not isinstance(override, dict):
        return out
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(base.get(key), dict):
            out[key] = merge(base[key], value)
        elif value is not None:
            out[key] = value
    return out


def load_config() -> dict:
    path = config_path()
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raw = {}
    except (OSError, ValueError) as err:
        log(f"config を読めないので既定値を使います: {err}")
        raw = {}
    return merge(DEFAULTS, raw)


def log(message: str) -> None:
    print(f"[zunda-notify] {message}", file=sys.stderr)


# ---------------------------------------------------------------- フック入力の解釈


def classify(hook: dict) -> str | None:
    event = hook.get("hook_event_name")
    if event == "Stop":
        # Stop フック自身が続行させた後の Stop は読み上げない
        return None if hook.get("stop_hook_active") else "stop"
    if event == "Notification":
        kind = hook.get("notification_type") or ""
        if kind == "permission_prompt":
            return "permission"
        if kind in ("elicitation_dialog", "elicitation_url_dialog"):
            return "question"
        if kind in ("idle_prompt", "agent_needs_input"):
            return "idle"
        # 古い Claude Code は notification_type を付けないので文面で判定
        message = str(hook.get("message") or "")
        if not kind and "permission" in message.lower():
            return "permission"
        if not kind and "waiting for your input" in message.lower():
            return "idle"
    return None


def run_quiet(args: list[str], timeout: float = 3.0, env: dict | None = None) -> str | None:
    try:
        done = subprocess.run(args, capture_output=True, text=True, timeout=timeout, env=env, check=False)
    except (OSError, subprocess.SubprocessError):
        return None
    return done.stdout if done.returncode == 0 else None


def herdr_bin(cfg: dict) -> str | None:
    configured = cfg.get("herdr", {}).get("bin")
    if configured:
        return configured
    found = shutil.which("herdr")
    if found:
        return found
    for candidate in (
        Path.home() / ".local" / "bin" / "herdr",
        Path("/opt/homebrew/bin/herdr"),
        Path("/usr/local/bin/herdr"),
        Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "Herdr" / "bin" / "herdr.exe",
    ):
        if candidate.is_file():
            return str(candidate)
    return None


def herdr_workspace_label(cfg: dict) -> str | None:
    workspace_id = os.environ.get("HERDR_WORKSPACE_ID")
    binary = herdr_bin(cfg) if workspace_id else None
    if not binary:
        return None
    out = run_quiet([binary, "workspace", "get", workspace_id])
    if not out:
        return None
    try:
        label = json.loads(out.strip().splitlines()[-1])["result"]["workspace"]["label"]
    except (ValueError, KeyError, IndexError, TypeError):
        return None
    return str(label).strip() or None


def place_name(hook: dict, cfg: dict) -> str:
    label = herdr_workspace_label(cfg)
    if label:
        return label
    cwd = str(hook.get("cwd") or os.getcwd()).rstrip("/\\")
    return re.split(r"[/\\]", cwd)[-1] or "エージェント"


def read_transcript_tail(path: str | None, max_bytes: int = 400_000) -> list[dict]:
    """transcript JSONL の末尾を読む。形式は Claude Code 内部仕様なので、読めない行は捨てる。"""
    if not path:
        return []
    try:
        with open(os.path.expanduser(path), "rb") as f:
            f.seek(0, os.SEEK_END)
            size = f.tell()
            f.seek(max(0, size - max_bytes))
            data = f.read().decode("utf-8", errors="replace")
    except OSError:
        return []
    entries = []
    for line in data.splitlines():
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        if isinstance(entry, dict):
            entries.append(entry)
    return entries


def content_blocks(entry: dict) -> list:
    message = entry.get("message")
    if not isinstance(message, dict) or message.get("role", entry.get("type")) != "assistant":
        return []
    content = message.get("content")
    if isinstance(content, str):
        return [{"type": "text", "text": content}]
    return content if isinstance(content, list) else []


def last_assistant_text(hook: dict, entries: list[dict]) -> str:
    text = hook.get("last_assistant_message")
    if isinstance(text, str) and text.strip():
        return text.strip()
    for entry in reversed(entries):
        texts = [b.get("text", "") for b in content_blocks(entry) if isinstance(b, dict) and b.get("type") == "text"]
        joined = "\n".join(t for t in texts if t).strip()
        if joined:
            return joined
    return ""


def pending_tool(entries: list[dict]) -> str:
    """許可待ちになっているツール呼び出し (直近の tool_use) を短く説明する。"""
    for entry in reversed(entries):
        for block in reversed(content_blocks(entry)):
            if not isinstance(block, dict) or block.get("type") != "tool_use":
                continue
            name = str(block.get("name") or "ツール")
            data = block.get("input") if isinstance(block.get("input"), dict) else {}
            detail = data.get("description") or data.get("command") or data.get("file_path") or data.get("url") or ""
            return f"{name}: {str(detail)[:200]}".strip(": ")
    return ""


def detail_for(kind: str, hook: dict) -> str:
    entries = read_transcript_tail(hook.get("transcript_path")) if kind != "stop" or not hook.get("last_assistant_message") else []
    if kind == "stop":
        # 最終報告の要点は末尾にあることが多いので後ろを優先して渡す
        return last_assistant_text(hook, entries)[-1500:]
    lines = [str(hook.get("message") or "").strip()]
    if kind == "permission":
        tool = pending_tool(entries)
        if tool:
            lines.append(f"実行しようとしているもの: {tool}")
    recent = last_assistant_text({}, entries)
    if recent:
        lines.append(f"直前のエージェントの発言: {recent[-600:]}")
    return "\n".join(line for line in lines if line)


# ---------------------------------------------------------------- 文面づくり


def sanitize(text: str, max_chars: int) -> str:
    text = re.sub(r"<think>.*?(</think>|$)", "", text, flags=re.S | re.I)
    text = re.sub(r"https?://\S+", "", text)
    text = re.sub(r"```.*?(```|$)", "", text, flags=re.S)  # コードブロックは読まない
    text = re.sub(r"`([^`\n]*)`", r"\1", text)  # インラインコードは中身だけ
    text = re.sub(r"[*_#>|`~\[\]「」『』\"“”]", "", text)
    text = re.sub(r"\s*\n\s*", "", text)
    text = re.sub(r"\s{2,}", " ", text).strip(" 　")
    if len(text) > max_chars:
        cut = text[:max_chars]
        end = max(cut.rfind("。"), cut.rfind("！"), cut.rfind("？"))
        # 途中で切れた文を読むより、短くても言い切った文のほうが聞き取りやすい
        text = cut[: end + 1] if end >= 0 else cut.rstrip("、") + "。"
    return text


def http_json(url: str, payload: dict, timeout: float, headers: dict | None = None) -> dict:
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json", **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return json.loads(res.read().decode("utf-8"))


def ask_llm(llm: dict, system: str, user: str) -> str | None:
    provider = str(llm.get("provider") or "none").lower()
    url = str(llm.get("url") or "").rstrip("/")
    timeout = float(llm.get("timeoutSec") or 25)
    messages = [{"role": "system", "content": system}, {"role": "user", "content": user}]
    try:
        if provider == "ollama":
            payload = {
                "model": llm.get("model"),
                "messages": messages,
                "stream": False,
                "think": False,
                "keep_alive": "15m",
                "options": {"temperature": 0.4, "num_predict": 200},
            }
            try:
                data = http_json(f"{url}/api/chat", payload, timeout)
            except urllib.error.HTTPError as err:
                if err.code != 400:
                    raise
                payload.pop("think")  # think を受け付けない古い Ollama / モデル向け
                data = http_json(f"{url}/api/chat", payload, timeout)
            return str(data.get("message", {}).get("content") or "") or None
        if provider == "openai":
            headers = {"Authorization": f"Bearer {llm['apiKey']}"} if llm.get("apiKey") else {}
            base = url if url.endswith("/v1") else f"{url}/v1"
            payload = {"model": llm.get("model"), "messages": messages, "temperature": 0.4, "max_tokens": 200}
            data = http_json(f"{base}/chat/completions", payload, timeout, headers)
            return str(data["choices"][0]["message"]["content"] or "") or None
    except (OSError, ValueError, KeyError, IndexError, TypeError, urllib.error.URLError) as err:
        log(f"LLM に聞けなかったので定型文にします: {err}")
    return None


def compose(kind: str, place: str, detail: str, voice: dict) -> str:
    max_chars = int(voice.get("maxChars") or 90)
    fallback = FALLBACK_TEMPLATES[kind].format(place=place)
    user = f"場所: {place}\n出来事: {EVENT_DESCRIPTIONS[kind]}\n詳細:\n{detail or '(なし)'}"
    answer = ask_llm(voice.get("llm", {}), SYSTEM_PROMPT.format(max_chars=max_chars), user)
    text = sanitize(answer or "", max_chars)
    # 短すぎる・ずんだもんになっていない応答は使わない
    if len(text) < 8 or "のだ" not in text:
        return fallback
    return text


# ---------------------------------------------------------------- 発声


def voicevox_wav(voice: dict, text: str) -> bytes:
    base = str(voice.get("voicevoxUrl") or DEFAULTS["voice"]["voicevoxUrl"]).rstrip("/")
    speaker = int(voice.get("speaker", 3))
    query_url = f"{base}/audio_query?" + urllib.parse.urlencode({"text": text, "speaker": speaker})
    with urllib.request.urlopen(urllib.request.Request(query_url, data=b"", method="POST"), timeout=15) as res:
        query = json.loads(res.read().decode("utf-8"))
    query["speedScale"] = float(voice.get("speedScale", 1.15))
    query["volumeScale"] = float(voice.get("volumeScale", 1.0))
    synth = urllib.request.Request(
        f"{base}/synthesis?speaker={speaker}",
        data=json.dumps(query).encode("utf-8"),
        headers={"Content-Type": "application/json", "Accept": "audio/wav"},
        method="POST",
    )
    with urllib.request.urlopen(synth, timeout=60) as res:
        return res.read()


def ps_quote(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def powershell(script: str) -> list[str]:
    # -Command に渡すと Windows のコマンドライン引用で記号や改行が崩れるので、UTF-16LE の base64 で渡す
    encoded = base64.b64encode(script.encode("utf-16-le")).decode("ascii")
    return ["powershell", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded]


def player_command(path: str) -> list[str] | None:
    system = platform.system()
    if system == "Darwin":
        return ["afplay", path]
    if system == "Windows":
        return powershell(f"(New-Object Media.SoundPlayer {ps_quote(path)}).PlaySync()")
    for cmd in (["paplay", path], ["aplay", "-q", path], ["ffplay", "-nodisp", "-autoexit", "-loglevel", "quiet", path], ["play", "-q", path]):
        if shutil.which(cmd[0]):
            return cmd
    return None


def os_tts_command(text: str) -> list[str] | None:
    system = platform.system()
    if system == "Darwin":
        return ["say", "-v", "Kyoko", text]
    if system == "Windows":
        return powershell(f"Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).Speak({ps_quote(text)})")
    for cmd in (["spd-say", "-w", "-l", "ja", text], ["espeak-ng", "-v", "ja", text]):
        if shutil.which(cmd[0]):
            return cmd
    return None


class PlaybackLock:
    """複数のエージェントが同時に終わっても声が重ならないよう、再生だけ1つずつにする。"""

    STALE_SEC = 90

    def __init__(self, wait_sec: float = 120):
        self.path = Path(tempfile.gettempdir()) / "herdr-vsd-deck-voice.lock"
        self.wait_sec = wait_sec
        self.held = False

    def __enter__(self):
        deadline = time.time() + self.wait_sec
        while True:
            try:
                fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                os.write(fd, str(os.getpid()).encode())
                os.close(fd)
                self.held = True
                return self
            except FileExistsError:
                try:
                    if time.time() - self.path.stat().st_mtime > self.STALE_SEC:
                        self.path.unlink()
                        continue
                except FileNotFoundError:
                    continue
                if time.time() > deadline:
                    return self  # 待ちすぎたら重なってもよいので話す
                time.sleep(0.2)

    def __exit__(self, *exc):
        if self.held:
            try:
                self.path.unlink()
            except FileNotFoundError:
                pass


def speak(voice: dict, text: str) -> str:
    """読み上げて、使った手段 ('voicevox' / 'os' / 'none') を返す。"""
    wav = None
    try:
        wav = voicevox_wav(voice, text)
    except (OSError, ValueError, urllib.error.URLError) as err:
        log(f"VOICEVOX に接続できません: {err}")

    with PlaybackLock():
        if wav:
            fd, path = tempfile.mkstemp(prefix="zunda-", suffix=".wav")
            try:
                with os.fdopen(fd, "wb") as f:
                    f.write(wav)
                cmd = player_command(path)
                if cmd and run_quiet(cmd, timeout=120) is not None:
                    return "voicevox"
                log("WAV を再生できませんでした")
            finally:
                try:
                    os.unlink(path)
                except OSError:
                    pass
        if voice.get("fallbackTts", True):
            cmd = os_tts_command(text)
            if cmd and run_quiet(cmd, timeout=120) is not None:
                return "os"
            # Kyoko の音声が入っていない Mac では既定の声で
            if cmd and cmd[0] == "say" and run_quiet(["say", text], timeout=120) is not None:
                return "os"
    return "none"


# ---------------------------------------------------------------- 入口


def check(cfg: dict) -> int:
    voice = cfg["voice"]
    ok = True
    base = str(voice["voicevoxUrl"]).rstrip("/")
    try:
        with urllib.request.urlopen(f"{base}/version", timeout=5) as res:
            print(f"VOICEVOX: OK (version {res.read().decode().strip()}) {base}")
    except (OSError, urllib.error.URLError) as err:
        ok = False
        print(f"VOICEVOX: NG {base} ({err})  → VOICEVOX を起動してください")
    llm = voice["llm"]
    if str(llm.get("provider")).lower() == "none":
        print("LLM: 使わない設定 (定型文で読み上げます)")
    else:
        answer = ask_llm(llm, SYSTEM_PROMPT.format(max_chars=voice["maxChars"]), "場所: テスト\n出来事: 動作確認\n詳細:\n接続テストです。")
        if answer:
            print(f"LLM: OK ({llm.get('provider')} {llm.get('model')}) → {sanitize(answer, int(voice['maxChars']))}")
        else:
            ok = False
            print(f"LLM: NG ({llm.get('provider')} {llm.get('url')} {llm.get('model')}) → 定型文で読み上げます")
    print(f"再生コマンド: {' '.join(player_command('<wav>') or ['見つかりません'])}")
    return 0 if ok else 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Claude Code の状況をずんだもんが読み上げるフック")
    parser.add_argument("--dry-run", action="store_true", help="読み上げずに文面だけ表示する")
    parser.add_argument("--say", metavar="TEXT", help="フック入力を使わず、TEXT をそのまま読み上げる")
    parser.add_argument("--check", action="store_true", help="VOICEVOX と LLM への接続を確認する")
    args = parser.parse_args(argv)

    cfg = load_config()
    voice = cfg["voice"]
    if args.check:
        return check(cfg)
    if args.say:
        print(speak(voice, args.say))
        return 0

    try:
        hook = json.loads(sys.stdin.read() or "{}")
    except ValueError:
        log("フック入力が JSON ではありません")
        return 0
    if not isinstance(hook, dict):
        return 0
    if not voice.get("enabled", True) or os.environ.get("HERDR_VSD_DECK_MUTE") == "1":
        return 0
    kind = classify(hook)
    if not kind or not voice.get("events", {}).get(kind, False):
        return 0

    place = place_name(hook, cfg)
    text = compose(kind, place, detail_for(kind, hook), voice)
    if args.dry_run:
        print(text)
        return 0
    speak(voice, text)
    return 0  # フックの失敗で Claude Code を止めない


if __name__ == "__main__":
    sys.exit(main())
