#!/bin/bash
# reaper-compose のインストール (macOS)
#
#   bash reaper-compose/scripts/install.sh [--autostart]
#
# 1. skill を ~/.claude/skills/reaper-compose にコピーする
#    (中身が違う既存のものは ~/.claude/backups/ に退避。skills の中に置くと二重に読み込まれるため)
# 2. REAPER のブリッジを ~/Library/Application Support/REAPER/Scripts/ReaperAI/ に置く
# 3. 作業フォルダ ~/ReaperAI を作る (CLAUDE.md・PREFERENCES.md)
# 4. --autostart なら REAPER 起動時にブリッジが自動で立ち上がるようにする
#
# 環境変数 REAPER_RESOURCE_PATH / REAPER_AI_DIR / CLAUDE_SKILLS_DIR で置き場所を変えられる。

set -euo pipefail

AUTOSTART=0
for arg in "$@"; do
  case "$arg" in
    --autostart) AUTOSTART=1 ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

SKILL_SRC="$(cd "$(dirname "$0")/.." && pwd)"
SKILLS_DIR="${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}"
SKILL_DST="$SKILLS_DIR/reaper-compose"
REAPER_RES="${REAPER_RESOURCE_PATH:-$HOME/Library/Application Support/REAPER}"
WORK="${REAPER_AI_DIR:-$HOME/ReaperAI}"

say() { printf '%s\n' "$*"; }

# --- Python -----------------------------------------------------------------
if ! command -v python3 >/dev/null 2>&1 || ! python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)' 2>/dev/null; then
  say "Python 3.9 以上が必要です。ターミナルで xcode-select --install を実行してから、もう一度このスクリプトを実行してください。"
  exit 1
fi

if [ ! -d "$REAPER_RES" ]; then
  say "REAPER の設定フォルダが見つかりません: $REAPER_RES"
  say "REAPER を一度起動してから、もう一度このスクリプトを実行してください。"
  exit 1
fi

# --- 1. skill ---------------------------------------------------------------
if [ "$SKILL_SRC" != "$SKILL_DST" ]; then
  mkdir -p "$SKILLS_DIR"
  if [ -e "$SKILL_DST" ]; then
    if diff -rq -x __pycache__ "$SKILL_SRC/SKILL.md" "$SKILL_DST/SKILL.md" >/dev/null 2>&1 \
      && diff -rq -x __pycache__ "$SKILL_SRC/scripts" "$SKILL_DST/scripts" >/dev/null 2>&1 \
      && diff -rq "$SKILL_SRC/reaper" "$SKILL_DST/reaper" >/dev/null 2>&1 \
      && diff -rq "$SKILL_SRC/references" "$SKILL_DST/references" >/dev/null 2>&1; then
      rm -rf "$SKILL_DST"
    else
      backup="$HOME/.claude/backups/reaper-compose-$(date +%Y%m%d-%H%M%S)"
      mkdir -p "$(dirname "$backup")"
      mv "$SKILL_DST" "$backup"
      say "以前の skill に変更があったので退避しました: $backup"
    fi
  fi
  mkdir -p "$SKILL_DST"
  cp -R "$SKILL_SRC/SKILL.md" "$SKILL_SRC/scripts" "$SKILL_SRC/reaper" "$SKILL_SRC/references" "$SKILL_DST/"
  say "skill をインストールしました: $SKILL_DST"
fi

# --- 2. REAPER のブリッジ ---------------------------------------------------------
mkdir -p "$REAPER_RES/Scripts/ReaperAI"
cp "$SKILL_SRC/reaper/ai_bridge.lua" "$REAPER_RES/Scripts/ReaperAI/ai_bridge.lua"
say "ブリッジを置きました: $REAPER_RES/Scripts/ReaperAI/ai_bridge.lua"

if [ "$AUTOSTART" = 1 ]; then
  startup="$REAPER_RES/Scripts/__startup.lua"
  marker="-- ReaperAI bridge (reaper-compose)"
  if [ -f "$startup" ] && grep -qF -- "$marker" "$startup"; then
    say "自動起動はすでに設定済みです: $startup"
  else
    {
      printf '\n%s\n' "$marker"
      printf '%s\n' 'dofile(reaper.GetResourcePath() .. "/Scripts/ReaperAI/ai_bridge.lua")'
    } >> "$startup"
    say "REAPER の起動時にブリッジが立ち上がるようにしました: $startup"
  fi
fi

# --- 3. 作業フォルダ ---------------------------------------------------------------
mkdir -p "$WORK/songs" "$WORK/.bridge/inbox" "$WORK/.bridge/outbox"

if [ ! -f "$WORK/CLAUDE.md" ]; then
  cat > "$WORK/CLAUDE.md" <<'EOF'
# ReaperAI 作業フォルダ

REAPER で曲を作るためのフォルダ。REAPER・曲・MIDI・アレンジの話は reaper-compose skill の手順で進める。

- 曲ごとのノート: songs/<曲のslug>/NOTES.md
- 書き込んだパートの JSON: songs/<曲のslug>/parts/<パート>-v<N>.json
- 曲をまたぐ好みや持っている音源: PREFERENCES.md
- .bridge/ は REAPER との連絡用。中身を手で触らない
EOF
  say "作成: $WORK/CLAUDE.md"
fi

if [ ! -f "$WORK/PREFERENCES.md" ]; then
  cat > "$WORK/PREFERENCES.md" <<'EOF'
# 好みと環境

- 楽器: ピアノが弾ける
- 以前の DAW: Cubase 13 (音名は C3=60 の表記に慣れている)
- 持っている音源: (未記入。ピアノ・ストリングス・ドラムに使っている音源を書く)
- 好きなジャンル・参考アーティスト: (未記入)
- 苦手・使いたくない音: (未記入)
EOF
  say "作成: $WORK/PREFERENCES.md"
fi

cat <<EOF

インストールが終わりました。次の手順で使い始められます。

1. REAPER で Actions → Show action list を開く
   → New action → Load ReaScript... → Scripts/ReaperAI/ai_bridge.lua を選ぶ
   → 一覧に出た「Script: ai_bridge.lua」を Run
   (コンソールに "ReaperAI bridge ... started" と出れば成功)
2. Claude Code のデスクトップアプリで、フォルダ $WORK を開く
3. 「REAPERとつながってるか確認して」と話しかける
EOF
