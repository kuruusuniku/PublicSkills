#!/usr/bin/env bash
# VSD Craft (VSDinside の Stream Dock) に herdr deck プラグインを入れる (macOS / Windows の Git Bash)。
#
#   bash scripts/install-vsd.sh              # プラグインフォルダを自動で探す
#   bash scripts/install-vsd.sh <plugins>    # プラグインフォルダを直接指定する
#
# プラグインフォルダが見つからないときは、VSD Craft の 設定 → 一般 →「アプリケーションフォルダを開く」で
# 開いたフォルダの中の plugins (Plugins) を指定してください。
set -euo pipefail

cd "$(dirname "$0")/.."
PLUGIN_NAME="com.kuruusuniku.herdr-deck.sdPlugin"
SRC="vsd/${PLUGIN_NAME}"

if [ ! -d node_modules ]; then
  echo "==> npm install"
  npm install
fi
echo "==> ビルド"
npm run build >/dev/null
test -f "${SRC}/bin/plugin.js" || { echo "ビルドに失敗しました (${SRC}/bin/plugin.js がありません)" >&2; exit 1; }

DEST_ROOT="${1:-}"
if [ -z "${DEST_ROOT}" ]; then
  candidates=(
    "${HOME}/Library/Application Support/HotSpot/StreamDock/plugins"
    "${HOME}/Library/Application Support/HotSpot/StreamDock/Plugins"
    "${APPDATA:-/nonexistent}/HotSpot/StreamDock/plugins"
    "${APPDATA:-/nonexistent}/HotSpot/StreamDock/Plugins"
  )
  for c in "${candidates[@]}"; do
    if [ -d "${c}" ]; then
      DEST_ROOT="${c}"
      break
    fi
  done
fi
if [ -z "${DEST_ROOT}" ] || [ ! -d "${DEST_ROOT}" ]; then
  cat >&2 <<'MSG'
VSD Craft のプラグインフォルダが見つかりませんでした。
VSD Craft の 設定 → 一般 →「アプリケーションフォルダを開く」で開いたフォルダの中にある
plugins (または Plugins) フォルダのパスを引数に渡してください:

  bash scripts/install-vsd.sh "/path/to/HotSpot/StreamDock/plugins"
MSG
  exit 1
fi

DEST="${DEST_ROOT}/${PLUGIN_NAME}"
echo "==> ${DEST} にコピー"
rm -rf "${DEST}"
mkdir -p "${DEST}"
cp -R "${SRC}/." "${DEST}/"

echo
echo "インストールしました。VSD Craft を終了して起動し直してください。"
echo "アクション一覧の「herdr deck」→「herdr タブ」をボタンに置くと使えます。"
echo "うまく動かないときのログ: ~/.config/herdr-deck/vsd-plugin.log"
