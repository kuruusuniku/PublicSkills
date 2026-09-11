#!/usr/bin/env bash
#
# rasterize.sh — SVG をラスタ画像 (JPEG / PNG) に変換する
#
# Usage:
#   rasterize.sh --in <file.svg> --out <file.jpg> --px <長辺px> --quality <1-100>
#
# 変換手段は次の順に試し、最初に成功したものを使う:
#   1. Chrome/Chromium ヘッドレス (--headless --screenshot)
#   2. rsvg-convert
#   3. ImageMagick magick  (内蔵 SVG レンダラは <text> のフォント解決に失敗しやすいので最後)
#
# 小さい出力・極端なアスペクト比の扱い (重要):
#   Chrome のレイアウトビューポートには縦横それぞれ約 500px の下限がある。SVG を
#   100vw/100vh (ビューポート基準) でレイアウトすると、出力の短辺が 500px を割るとき
#   SVG がビューポート下限の中でレターボックス化され、寸法は指定どおりなのに内容が
#   欠ける (実測: 3:2 で --px 300、4:1 で --px 1000 = 短辺 250px のとき欠落)。
#   そこで SVG は 100vw/100vh ではなく出力寸法そのもの (幅 Wpx / 高さ Hpx) で
#   レイアウトする。SVG の大きさがビューポートに依存しなくなるため、短辺が
#   ビューポート下限を割っても内容は欠けない (--px 16 から実測で確認済み)。
#   アップスケールして縮小し直す必要も無いので、小さい出力でも magick は不要。
#
# Chrome のタイムアウト:
#   Chrome ヘッドレスは「PNG を書き終えたのにプロセスが終了しない」ことがある
#   (間欠的で原因は特定できていない)。無期限に待たないよう既定 60 秒で打ち切る。
#   打ち切った時点で PNG が最後まで (IEND チャンクまで) 書けていればそれを採用し、
#   途中までなら破棄する。使える PNG が残らなかったときは 2 秒待って起動し直す
#   (ハングは入力依存ではなく一時的な状態で、起動し直すと成功することを実測済み)。
#   再試行しても駄目なら次の手段 (rsvg-convert / magick) に進む。
#   即座に失敗した場合は systematic な問題とみなし、再試行せず次の手段に進む。
#   環境変数: RASTERIZE_CHROME_TIMEOUT (秒, 既定 60) / RASTERIZE_CHROME_RETRIES (既定 1)
#
# 入力 SVG の妥当性:
#   python3 があるときは XML として整形式かを先に確かめ、壊れていれば異常終了する。
#   Chrome は閉じていないタグを部分描画して「一見成功」してしまい、呼び出し側から
#   図版の破損に気づけないため。python3 が無い環境ではこの検査は省略する。
#
# PNG -> JPEG の変換には magick を使う。magick が無い場合は JPEG にできないため
# <out> の拡張子を .png に差し替えて PNG のまま出力する。
#
# 最終行に結果を機械可読で出す:
#   OUT=<実際の出力パス> FORMAT=<jpg|png> RENDERER=<chrome|rsvg|magick>
#
# bash 3.2 互換。

set -euo pipefail

SELF_NAME="rasterize.sh"
CHROME_TIMEOUT="${RASTERIZE_CHROME_TIMEOUT:-60}"
CHROME_RETRIES="${RASTERIZE_CHROME_RETRIES:-1}"
IN=""
OUT=""
PX=""
QUALITY=""

usage() {
  # 先頭の # コメントブロック (shebang の次行から、# 以外の行が来る手前まで) を出す。
  # 行数を固定するとヘッダ追記のたびに実装コードが漏れるため動的に取る。
  awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "$0"
}

die() { echo "[$SELF_NAME] ERROR: $*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --in)      IN="${2:-}"; shift 2 ;;
    --out)     OUT="${2:-}"; shift 2 ;;
    --px)      PX="${2:-}"; shift 2 ;;
    --quality) QUALITY="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "[$SELF_NAME] ERROR: 不明なオプション '$1'" >&2; usage >&2; exit 1 ;;
  esac
done

[ -n "$IN" ]  || die "--in <file.svg> は必須です"
[ -n "$OUT" ] || die "--out <file.jpg> は必須です"
[ -f "$IN" ]  || die "入力 SVG が見つかりません: $IN"
PX="${PX:-2048}"
QUALITY="${QUALITY:-88}"

case "$CHROME_TIMEOUT" in
  ''|*[!0-9]*) die "RASTERIZE_CHROME_TIMEOUT は正の整数(秒)で指定してください (指定値: $CHROME_TIMEOUT)" ;;
esac
[ "$CHROME_TIMEOUT" -ge 1 ] || die "RASTERIZE_CHROME_TIMEOUT は 1 以上で指定してください (指定値: $CHROME_TIMEOUT)"
case "$CHROME_RETRIES" in
  ''|*[!0-9]*) die "RASTERIZE_CHROME_RETRIES は 0 以上の整数で指定してください (指定値: $CHROME_RETRIES)" ;;
esac

case "$PX" in
  ''|*[!0-9]*) die "--px は正の整数で指定してください (指定値: $PX)" ;;
esac
[ "$PX" -ge 16 ] || die "--px は 16 以上で指定してください (指定値: $PX)"
case "$QUALITY" in
  ''|*[!0-9]*) die "--quality は 1-100 の整数で指定してください (指定値: $QUALITY)" ;;
esac
if [ "$QUALITY" -lt 1 ] || [ "$QUALITY" -gt 100 ]; then
  die "--quality は 1-100 の整数で指定してください (指定値: $QUALITY)"
fi

# 入力 SVG が XML として整形式かを先に確かめる。閉じていないタグでも Chrome は
# 部分描画して exit 0 になり、呼び出し側が破損に気づけないため。
# python3 が無い環境では検査を飛ばす (rasterize.sh 自体は python3 に依存しない)。
if command -v python3 >/dev/null 2>&1; then
  if ! python3 -B -c 'import sys, xml.etree.ElementTree as ET; ET.parse(sys.argv[1])' \
       "$IN" >/dev/null 2>&1; then
    die "--in の SVG が XML として整形式ではありません: $IN
  閉じていないタグ・不正な文字参照・エスケープ漏れ (& < > を実体参照にしていない) が無いか確認してください。
  この検査を外すと壊れた画像が黙って出力されるため、ここで止めています。"
  fi
fi

OUT_DIR="$(dirname "$OUT")"
mkdir -p "$OUT_DIR"

# ---- viewBox からアスペクト比を取り、長辺を $PX に合わせた W x H を決める ----
VIEWBOX="$(tr '\n,' '  ' < "$IN" | sed -n 's/.*viewBox="\([^"]*\)".*/\1/p' | head -1)"
VB_W=""; VB_H=""
if [ -n "$VIEWBOX" ]; then
  # shellcheck disable=SC2086
  set -- $VIEWBOX
  if [ $# -ge 4 ]; then VB_W="$3"; VB_H="$4"; fi
fi
if [ -z "$VB_W" ] || [ -z "$VB_H" ]; then
  # viewBox が無い SVG は正方形とみなす
  VB_W=1; VB_H=1
fi

DIMS="$(awk -v vw="$VB_W" -v vh="$VB_H" -v px="$PX" 'BEGIN{
  if (vw <= 0 || vh <= 0) { vw = 1; vh = 1 }
  if (vw >= vh) { w = px; h = px * vh / vw } else { h = px; w = px * vw / vh }
  w = int(w + 0.5); h = int(h + 0.5)
  if (w < 1) w = 1; if (h < 1) h = 1
  printf "%d %d", w, h
}')"
W="${DIMS% *}"
HGT="${DIMS#* }"

TMPDIR_R="$(mktemp -d "${TMPDIR:-/tmp}/rasterize.XXXXXX")"
cleanup() { rm -rf "$TMPDIR_R"; }
trap cleanup EXIT INT TERM
PNG="$TMPDIR_R/page.png"

# ---- 1. Chrome / Chromium ヘッドレス ----
find_chrome() {
  if [ -n "${CHROME_BIN:-}" ] && [ -x "$CHROME_BIN" ]; then
    printf '%s' "$CHROME_BIN"; return 0
  fi
  local c
  for c in google-chrome google-chrome-stable chromium chromium-browser; do
    if command -v "$c" >/dev/null 2>&1; then command -v "$c"; return 0; fi
  done
  for c in \
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    "/Applications/Chromium.app/Contents/MacOS/Chromium"; do
    if [ -x "$c" ]; then printf '%s' "$c"; return 0; fi
  done
  return 1
}

RENDERER=""
CHROME="$(find_chrome || true)"

if [ -n "$CHROME" ]; then
  WRAP="$TMPDIR_R/wrap.html"
  {
    # SVG の大きさをビューポート (100vw/100vh) に紐付けると、短辺が Chrome の
    # レイアウト下限 (約500px) を割ったときにレターボックス化されて内容が欠ける。
    # 出力寸法そのものを CSS px で指定してビューポート非依存にする。
    printf '<!doctype html><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:#ffffff}svg{display:block;width:%spx;height:%spx}</style>' "$W" "$HGT"
    cat "$IN"
  } > "$WRAP"

  # 子プロセスごと確実に落とす (Chrome はヘルパープロセスを多数持つ)
  _kill_tree() {
    local p="$1" sig="$2" c
    if command -v pgrep >/dev/null 2>&1; then
      for c in $(pgrep -P "$p" 2>/dev/null); do _kill_tree "$c" "$sig"; done
    fi
    kill "-$sig" "$p" 2>/dev/null || true
  }

  # Chrome が終了しないことがあるので必ず時間で打ち切る
  CHROME_TIMED_OUT=0
  shot() {
    # 試行ごとに立て直す (前の試行の打ち切りフラグを引きずらない)
    CHROME_TIMED_OUT=0
    rm -f "$PNG"
    "$CHROME" --headless --disable-gpu --hide-scrollbars "$@" \
      --window-size="$W,$HGT" --screenshot="$PNG" "file://$WRAP" >/dev/null 2>&1 &
    local pid=$! waited=0
    while kill -0 "$pid" 2>/dev/null; do
      if [ "$waited" -ge "$CHROME_TIMEOUT" ]; then
        _kill_tree "$pid" TERM
        sleep 1
        _kill_tree "$pid" KILL
        wait "$pid" 2>/dev/null || true
        CHROME_TIMED_OUT=1
        return 0
      fi
      sleep 1
      waited=$((waited + 1))
    done
    wait "$pid" 2>/dev/null || true
  }

  # PNG が最後まで書けているか (IEND チャンクで終わっているか) を確かめる。
  # タイムアウトで kill したとき、書き込み途中の欠けた PNG を採用しないため。
  png_complete() {
    [ -s "$1" ] || return 1
    if command -v python3 >/dev/null 2>&1; then
      python3 -B -c '
import sys
d = open(sys.argv[1], "rb")
head = d.read(8)
d.seek(-12, 2)
tail = d.read()
sys.exit(0 if head == b"\x89PNG\r\n\x1a\n" and tail[4:8] == b"IEND" else 1)
' "$1" >/dev/null 2>&1 && return 0
      return 1
    fi
    if command -v magick >/dev/null 2>&1; then
      magick identify "$1" >/dev/null 2>&1 && return 0
      return 1
    fi
    # 検査手段が無いときはサイズだけで判断する (従来どおり)
    return 0
  }

  # Chrome の間欠ハングは入力依存ではなく一時的な状態なので (同じ wrap.html を
  # 単独で叩くと成功する)、打ち切ったら少し待って起動し直す。即失敗した場合は
  # systematic な問題なので再試行せず次の手段に進む (無駄に待たない)。
  chrome_attempt=1
  chrome_max_attempts=$((CHROME_RETRIES + 1))
  while :; do
    # 2>/dev/null は kill 時にシェルが出すジョブ終了通知を抑えるため
    shot 2>/dev/null
    if [ ! -s "$PNG" ] && [ "$CHROME_TIMED_OUT" -eq 0 ] && [ "$chrome_attempt" -eq 1 ]; then
      # root 実行の Linux コンテナ等では sandbox 無効化が要る
      shot --no-sandbox 2>/dev/null
    fi
    # Chrome は「PNG を書き終えたのにプロセスが終わらない」ことがある。その場合の
    # PNG は完全なので、打ち切った後でも健全なら採用する (実測で md5 一致を確認済み)。
    if [ "$CHROME_TIMED_OUT" -eq 1 ] && [ -s "$PNG" ] && ! png_complete "$PNG"; then
      echo "[$SELF_NAME] WARN: 打ち切り時の PNG が途中までしか書けていないため破棄します" >&2
      rm -f "$PNG"
    fi
    [ -s "$PNG" ] && break
    [ "$CHROME_TIMED_OUT" -eq 1 ] || break
    [ "$chrome_attempt" -ge "$chrome_max_attempts" ] && break
    echo "[$SELF_NAME] WARN: Chrome が ${CHROME_TIMEOUT} 秒以内に終わりませんでした。2 秒待って起動し直します (${chrome_attempt}/${CHROME_RETRIES} 回目の再試行)" >&2
    sleep 2
    chrome_attempt=$((chrome_attempt + 1))
  done
  if [ -s "$PNG" ]; then
    RENDERER="chrome"
    if [ "$CHROME_TIMED_OUT" -eq 1 ]; then
      echo "[$SELF_NAME] WARN: Chrome が ${CHROME_TIMEOUT} 秒以内に終わらなかったため打ち切りました ($CHROME)。" >&2
      echo "[$SELF_NAME]       PNG は最後まで書けていたのでそのまま使います (待ち時間は RASTERIZE_CHROME_TIMEOUT で変更できます)" >&2
    fi
  elif [ "$CHROME_TIMED_OUT" -eq 1 ]; then
    echo "[$SELF_NAME] WARN: Chrome が ${CHROME_TIMEOUT} 秒以内に終わらず、使える PNG も残しませんでした ($CHROME)。次の手段を試します" >&2
    echo "[$SELF_NAME]       (待ち時間は環境変数 RASTERIZE_CHROME_TIMEOUT で変更できます)" >&2
  else
    echo "[$SELF_NAME] WARN: Chrome ヘッドレスでの描画に失敗しました ($CHROME)。次の手段を試します" >&2
  fi
fi

# ---- 2. rsvg-convert ----
if [ -z "$RENDERER" ] && command -v rsvg-convert >/dev/null 2>&1; then
  if rsvg-convert -w "$W" -h "$HGT" -o "$PNG" "$IN" >/dev/null 2>&1 && [ -s "$PNG" ]; then
    RENDERER="rsvg"
  else
    echo "[$SELF_NAME] WARN: rsvg-convert での描画に失敗しました。次の手段を試します" >&2
  fi
fi

# ---- 3. ImageMagick (最後の手段: <text> のフォント解決に失敗しうる) ----
if [ -z "$RENDERER" ] && command -v magick >/dev/null 2>&1; then
  if magick -background none -density 300 "$IN" -resize "${W}x${HGT}" "$PNG" >/dev/null 2>&1 \
     && [ -s "$PNG" ]; then
    RENDERER="magick"
  else
    echo "[$SELF_NAME] WARN: magick の内蔵 SVG レンダラでの描画に失敗しました" >&2
    echo "[$SELF_NAME]       (<text> のフォント解決に失敗する既知の問題: 'unable to read font')" >&2
  fi
fi

if [ -z "$RENDERER" ]; then
  {
    echo "[$SELF_NAME] ERROR: SVG をラスタライズできる手段がありません。"
    echo "  試した手段と現状:"
    if [ -n "$CHROME" ] && [ "${CHROME_TIMED_OUT:-0}" -eq 1 ]; then
      echo "    - Chrome ヘッドレス: ${CHROME_TIMEOUT} 秒以内に終わらず打ち切った ($CHROME)"
      echo "        対処: RASTERIZE_CHROME_TIMEOUT で待ち時間を延ばすか、rsvg-convert を入れてください"
    elif [ -n "$CHROME" ]; then
      echo "    - Chrome ヘッドレス: 見つかったが描画に失敗 ($CHROME)"
    else
      echo "    - Chrome ヘッドレス: 見つからない"
      echo "        macOS: brew install --cask google-chrome"
      echo "        Linux: apt-get install -y chromium  (または Google Chrome を導入)"
      echo "        既にある場合: CHROME_BIN=/path/to/chrome を環境変数で指定してください"
    fi
    if command -v rsvg-convert >/dev/null 2>&1; then
      echo "    - rsvg-convert: 見つかったが描画に失敗"
    else
      echo "    - rsvg-convert: 見つからない  (macOS: brew install librsvg / Linux: apt-get install -y librsvg2-bin)"
    fi
    if command -v magick >/dev/null 2>&1; then
      echo "    - magick: 見つかったが描画に失敗 (内蔵 SVG レンダラのフォント解決エラーの可能性)"
    else
      echo "    - magick: 見つからない  (macOS: brew install imagemagick / Linux: apt-get install -y imagemagick)"
    fi
    echo "  上記のいずれか 1 つ (推奨: Chrome または librsvg) を入れてから再実行してください。"
  } >&2
  exit 1
fi

# ---- PNG -> JPEG ----
FORMAT="png"
FINAL_OUT="$OUT"
case "$OUT" in
  *.jpg|*.jpeg|*.JPG|*.JPEG) WANT_JPEG=1 ;;
  *) WANT_JPEG=0 ;;
esac

if [ "$WANT_JPEG" -eq 1 ]; then
  if command -v magick >/dev/null 2>&1; then
    if magick "$PNG" -background white -alpha remove -alpha off -strip \
         -sampling-factor 4:2:0 -quality "$QUALITY" "$OUT" >/dev/null 2>&1 && [ -s "$OUT" ]; then
      FORMAT="jpg"
    else
      die "magick による JPEG 変換に失敗しました: $OUT"
    fi
  else
    # magick が無いので JPEG にできない。PNG のまま出す (呼び出し側が manifest に記録する)
    FINAL_OUT="${OUT%.*}.png"
    cp "$PNG" "$FINAL_OUT"
    FORMAT="png"
    echo "[$SELF_NAME] WARN: magick が無いため JPEG 変換できません。PNG で出力します: $FINAL_OUT" >&2
    echo "[$SELF_NAME]       JPEG が必要なら ImageMagick を入れてください (brew install imagemagick)" >&2
  fi
else
  cp "$PNG" "$FINAL_OUT"
  FORMAT="png"
fi

[ -s "$FINAL_OUT" ] || die "出力ファイルが空です: $FINAL_OUT"

echo "OUT=$FINAL_OUT FORMAT=$FORMAT RENDERER=$RENDERER"
