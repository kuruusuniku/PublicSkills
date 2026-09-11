#!/usr/bin/env bash
#
# run-slack-html/scripts/svg2png.sh — SVG を PNG にラスタライズする
#
# Usage: svg2png.sh <input.svg> <output.png> [--scale N] [--width W] [--height H] [--jpeg Q]
#
#   --scale N    描画倍率 (既定 2 = Retina相当。0 < N <= 10)
#   --width  W   描画幅を明示 (px)。SVGから判定できないときに使う
#   --height H   描画高を明示 (px)
#   --jpeg   Q   PNGではなくJPEG(品質 Q, 0-100)で出力する。要 ImageMagick
#
# 依存: Chrome または Chromium(描画)、python3(SVGのサイズ判定)。
#       --jpeg を使うときだけ ImageMagick も要る。
#
# run-ai-images(AI画像生成)が使えない環境向けのフォールバック。
# Claude 自身が書いた図解 SVG を、Chrome ヘッドレスで忠実にラスタライズする。
#
# なぜ Chrome か: ImageMagick の SVG 対応は内部レンダラ(MSVG)で、日本語フォント・
# CSS・グラデーションを正しく描けないことが多い(rsvg-convert 未導入の環境では
# `unable to read font` で即失敗する)。Chrome はブラウザと同じ描画結果になる。
#
# 設計上の約束: 出力は必ず一時ファイルに書いてから検証し、成功したときだけ
# 最終パスへ mv する。したがって失敗時に出力先が壊れたり、古いファイルが
# 残ったまま成功と報告されたりしない。
#
# 終了コード: 0 = 成功, 1 = 失敗, 2 = 引数エラー

set -uo pipefail

usage() {
  sed -n '3,13p' "$0" | sed 's/^#\{1,\} \{0,1\}//'
  exit 2
}

die()  { echo "ERROR: $*" >&2; exit 1; }
die2() { echo "ERROR: $*" >&2; exit 2; }

# 値を取るオプションの引数チェック。`--scale` を末尾に置いても
# 無限ループせず、引数エラーとして落ちるようにする。
# 空文字も拒否する(`--jpeg ""` を未指定と誤認すると、JPEGのつもりが
# .jpg という名前のPNGになる)。
need_value() {
  # $1 = オプション名, $2 = 残りの引数の数 ($#), $3 = 値
  [[ "$2" -ge 2 ]] || die2 "$1 に値が指定されていない"
  [[ -n "$3" ]]    || die2 "$1 の値が空になっている"
}

IN="" ; OUT="" ; SCALE=2 ; W="" ; H="" ; JPEG_Q="" ; ENDOPTS=0
while [[ $# -gt 0 ]]; do
  # `--` 以降は `-` で始まっていてもファイル名として扱う
  if [[ "$ENDOPTS" -eq 1 ]]; then
    if   [[ -z "$IN"  ]]; then IN="$1"
    elif [[ -z "$OUT" ]]; then OUT="$1"
    else echo "too many arguments: $1" >&2; usage; fi
    shift; continue
  fi
  case "$1" in
    --scale)  need_value "$1" "$#" "${2:-}"; SCALE="$2";  shift 2 ;;
    --width)  need_value "$1" "$#" "${2:-}"; W="$2";      shift 2 ;;
    --height) need_value "$1" "$#" "${2:-}"; H="$2";      shift 2 ;;
    --jpeg)   need_value "$1" "$#" "${2:-}"; JPEG_Q="$2"; shift 2 ;;
    # --opt=value 形式も受ける
    --scale=*)  SCALE="${1#*=}";  [[ -n "$SCALE"  ]] || die2 "--scale の値が空になっている";  shift ;;
    --width=*)  W="${1#*=}";      [[ -n "$W"      ]] || die2 "--width の値が空になっている";  shift ;;
    --height=*) H="${1#*=}";      [[ -n "$H"      ]] || die2 "--height の値が空になっている"; shift ;;
    --jpeg=*)   JPEG_Q="${1#*=}"; [[ -n "$JPEG_Q" ]] || die2 "--jpeg の値が空になっている";   shift ;;
    -h|--help) usage ;;
    --) ENDOPTS=1; shift ;;
    -*) echo "unknown option: $1" >&2; usage ;;
    *)  if   [[ -z "$IN"  ]]; then IN="$1"
        elif [[ -z "$OUT" ]]; then OUT="$1"
        else echo "too many arguments: $1" >&2; usage; fi
        shift ;;
  esac
done

[[ -n "$IN" && -n "$OUT" ]] || usage

# --- 引数の検証 --------------------------------------------------------------
[[ -f "$IN" ]] || die "入力SVGが見つからない: $IN"
[[ -r "$IN" ]] || die "入力SVGを読めない: $IN"

awk -v s="$SCALE" 'BEGIN{ exit !(s+0 > 0 && s+0 <= 10 && s ~ /^[0-9]+(\.[0-9]+)?$/) }' \
  || die2 "--scale は 0 より大きく 10 以下の数値で指定する: $SCALE"

for pair in "--width:$W" "--height:$H"; do
  name="${pair%%:*}"; val="${pair#*:}"
  [[ -z "$val" ]] && continue
  [[ "$val" =~ ^[0-9]+$ ]] || die2 "$name は整数で指定する: $val"
  [[ "$val" -gt 0 && "$val" -le 10000 ]] || die2 "$name は 1〜10000 の範囲で指定する: $val"
done

if [[ -n "$JPEG_Q" ]]; then
  [[ "$JPEG_Q" =~ ^[0-9]+$ ]] || die2 "--jpeg は 0〜100 の整数で指定する: $JPEG_Q"
  [[ "$JPEG_Q" -le 100 ]]     || die2 "--jpeg は 0〜100 の整数で指定する: $JPEG_Q"
fi

[[ -d "$OUT" ]] && die "出力先がディレクトリになっている: $OUT"
case "$OUT" in */) die "出力先がディレクトリ形式で終わっている: $OUT" ;; esac

# --- Chrome を探す -----------------------------------------------------------
CHROME="${CHROME:-}"
if [[ -z "$CHROME" ]]; then
  for c in \
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    "/Applications/Chromium.app/Contents/MacOS/Chromium" \
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" \
    "$(command -v google-chrome 2>/dev/null)" \
    "$(command -v google-chrome-stable 2>/dev/null)" \
    "$(command -v chromium 2>/dev/null)" \
    "$(command -v chromium-browser 2>/dev/null)" ; do
    if [[ -n "$c" && -x "$c" ]]; then CHROME="$c"; break; fi
  done
fi
if [[ -z "$CHROME" ]]; then
  echo "ERROR: Chrome/Chromium が見つからない。CHROME=/path/to/chrome を指定して再実行する。" >&2
  echo "       ブラウザを置けない環境では 'brew install librsvg' / 'apt install librsvg2-bin' で" >&2
  echo "       rsvg-convert を入れ、'rsvg-convert -z 2 in.svg -o out.png' で代替できる。" >&2
  exit 1
fi
[[ -x "$CHROME" ]] || die "CHROME が実行可能でない: $CHROME"

# --- SVG の描画サイズを決める ------------------------------------------------
# 優先度: 明示指定 > width/height 属性 > viewBox
if [[ -z "$W" || -z "$H" ]]; then
  command -v python3 >/dev/null 2>&1 \
    || die "python3 が見つからない(SVGのサイズ判定に必要)。--width と --height を明示すれば python3 なしでも動く"
  # Python の traceback(内部パスを含む)は出さない。失敗は自前の文言で伝える。
  SIZES="$(python3 - "$IN" 2>/dev/null <<'PYEOF'
import re, sys

src = open(sys.argv[1], encoding="utf-8", errors="replace").read()

# コメント・DOCTYPE・CDATA を先に落とす。これをやらないと
# コメント中の <svg width="16"> をルートタグと誤認する。
src = re.sub(r'<!--.*?-->', ' ', src, flags=re.S)
src = re.sub(r'<!\[CDATA\[.*?\]\]>', ' ', src, flags=re.S)
src = re.sub(r'<!DOCTYPE[^>[]*(\[.*?\])?[^>]*>', ' ', src, flags=re.S | re.I)

# シングルクォート文字はリテラルで書かない。この Python は bash の
# $( ... ) 内ヒアドキュメントに埋まっており、引用符が奇数個あると
# bash 側のパースが壊れる。
Q = chr(39)

tag_re = '<svg\\b((?:[^>"' + Q + ']|"[^"]*"|' + Q + '[^' + Q + ']*' + Q + ')*)>'
m = re.search(tag_re, src, re.S | re.I)
if not m:
    print(0, 0); sys.exit(0)

# 属性名を丸ごと取り出して完全一致で引く。部分一致で探すと
# stroke-width="2" の "width" を掴んでしまう。
attr_re = ('([A-Za-z_:][-\\w:.]*)\\s*=\\s*(?:"([^"]*)"|'
           + Q + '([^' + Q + ']*)' + Q + ')')
attrs = {}
for a in re.finditer(attr_re, m.group(1)):
    attrs.setdefault(a.group(1).lower(),
                     a.group(2) if a.group(2) is not None else a.group(3))

# CSS の絶対単位 → px (96dpi 基準)。相対単位 (%, em, ex...) は
# 基準が無いので「不明」扱いにして viewBox に委ねる。
UNITS = {"": 1.0, "px": 1.0, "in": 96.0, "cm": 96.0 / 2.54,
         "mm": 96.0 / 25.4, "pt": 96.0 / 72.0, "pc": 16.0, "q": 96.0 / 101.6}

def num(v):
    if v is None:
        return None
    n = re.match(r'\s*([0-9]*\.?[0-9]+)\s*([A-Za-z%]*)\s*$', v)
    if not n:
        return None
    factor = UNITS.get(n.group(2).lower())
    if factor is None:
        return None
    return float(n.group(1)) * factor

w, h = num(attrs.get("width")), num(attrs.get("height"))
if w is None or h is None:
    vb = attrs.get("viewbox")
    if vb:
        p = re.split(r'[\s,]+', vb.strip())
        if len(p) == 4:
            try:
                vw, vh = float(p[2]), float(p[3])
            except ValueError:
                vw = vh = None
            if vw and vh:
                if w is None and h is None:
                    w, h = vw, vh
                elif w is None:
                    w = h * vw / vh          # 縦横比を保って補完
                elif h is None:
                    h = w * vh / vw

print(int(round(w)) if w and w > 0 else 0,
      int(round(h)) if h and h > 0 else 0)
PYEOF
)" || SIZES="0 0"
  DW="${SIZES%% *}" ; DH="${SIZES##* }"
  [[ -z "$W" ]] && W="$DW"
  [[ -z "$H" ]] && H="$DH"
fi

if [[ ! "$W" =~ ^[0-9]+$ || ! "$H" =~ ^[0-9]+$ || "$W" -le 0 || "$H" -le 0 ]]; then
  die "SVG の描画サイズを判定できない。--width / --height で明示する: $IN"
fi
if [[ "$W" -gt 10000 || "$H" -gt 10000 ]]; then
  die "描画サイズが大きすぎる (${W}x${H})。--width / --height で現実的な値を指定する"
fi

# --- HTML でラップして撮影 ---------------------------------------------------
TMP="$(mktemp -d)" || die "一時ディレクトリを作れない"
trap 'rm -rf "$TMP"' EXIT

{
  printf '<!doctype html><meta charset="utf-8">\n'
  printf '<style>html,body{margin:0;padding:0;background:#fff}svg{display:block;width:%spx;height:%spx}</style>\n' "$W" "$H"
  cat "$IN"
} > "$TMP/page.html" || die "一時HTMLを書けない"

OUT_DIR="$(dirname "$OUT")"
if [[ ! -d "$OUT_DIR" ]]; then
  mkdir -p "$OUT_DIR" 2>/dev/null || die "出力ディレクトリを作れない: $OUT_DIR"
  echo "NOTE  出力ディレクトリを作成した: $OUT_DIR" >&2
fi
# cd の失敗メッセージ(内部パスと行番号を含む)は握り潰し、自前の文言で落とす。
OUT_DIR_ABS="$(cd "$OUT_DIR" 2>/dev/null && pwd)" \
  || die "出力ディレクトリを開けない(権限を確認する): $OUT_DIR"
OUT_ABS="$OUT_DIR_ABS/$(basename "$OUT")"
[[ -w "$OUT_DIR_ABS" ]] || die "出力ディレクトリに書き込めない: $OUT_DIR"
[[ -e "$OUT_ABS" && ! -w "$OUT_ABS" ]] && die "出力先を上書きできない(書き込み権限なし): $OUT_ABS"

# 撮影は必ず一時ファイルへ。既存の出力ファイルには最後まで触らない。
#
# Chrome は環境によっては終了せず固まることがあるため、必ず番人プロセスを付けて
# CHROME_TIMEOUT 秒で強制終了させる(`timeout(1)` は macOS 標準には無い)。
SHOT="$TMP/shot.png"
CHROME_TIMEOUT="${CHROME_TIMEOUT:-90}"

"$CHROME" --headless --disable-gpu --hide-scrollbars --no-sandbox \
  --force-device-scale-factor="$SCALE" \
  --window-size="${W},${H}" \
  --virtual-time-budget=5000 \
  --screenshot="$SHOT" \
  "file://$TMP/page.html" >/dev/null 2>&1 &
CHROME_PID=$!

( sleep "$CHROME_TIMEOUT"; kill -9 "$CHROME_PID" 2>/dev/null ) >/dev/null 2>&1 &
WATCHDOG_PID=$!

wait "$CHROME_PID"
kill "$WATCHDOG_PID" 2>/dev/null
wait "$WATCHDOG_PID" 2>/dev/null

[[ -f "$SHOT" && -s "$SHOT" ]] || die "ラスタライズに失敗した(Chrome が PNG を出力しなかった): $IN"
# PNG シグネチャを確認する。ファイルが在って非空でも中身が壊れていることがある。
head -c 8 "$SHOT" | od -An -tx1 2>/dev/null | tr -d ' \n' | grep -qi '^89504e470d0a1a0a$' \
  || die "ラスタライズ結果が PNG として壊れている: $IN"

# --- 任意: JPEG 変換 ---------------------------------------------------------
# 図解のようなフラットなベクター画像は PNG のほうが文字が潰れず、サイズも稼げる。
# 写真的・グラデーション主体の SVG のときだけ --jpeg を使う。
FINAL="$SHOT"
if [[ -n "$JPEG_Q" ]]; then
  MAGICK="$(command -v magick || command -v convert)" || true
  [[ -n "$MAGICK" ]] || die "--jpeg には ImageMagick が要る (brew install imagemagick)"
  # ImageMagick の生メッセージは一時ディレクトリの内部パスを含むので出さない。
  if ! "$MAGICK" "$SHOT" -quality "$JPEG_Q" "$TMP/shot.jpg" 2>/dev/null; then
    die "JPEG 変換に失敗した (--jpeg $JPEG_Q)。PNG のまま使うか品質値を変える"
  fi
  [[ -f "$TMP/shot.jpg" && -s "$TMP/shot.jpg" ]] || die "JPEG 出力が空になった (--jpeg $JPEG_Q)"
  head -c 2 "$TMP/shot.jpg" | od -An -tx1 2>/dev/null | tr -d ' \n' | grep -qi '^ffd8$' \
    || die "JPEG 出力が壊れている (--jpeg $JPEG_Q)"
  FINAL="$TMP/shot.jpg"
fi

# --- ここまで来て初めて出力先を触る ------------------------------------------
mv -f "$FINAL" "$OUT_ABS" || die "出力先へ移動できない: $OUT_ABS"

SIZE=$(wc -c < "$OUT_ABS" | tr -d ' ')
KB=$(awk -v s="$SIZE" 'BEGIN{printf "%.0f", s/1024}')
B64=$(awk -v s="$SIZE" 'BEGIN{printf "%.0f", s*4/3/1024}')
# W x H は CSS px。実画素は scale 倍になるので、誤読しないよう両方出す。
PW=$(awk -v w="$W" -v s="$SCALE" 'BEGIN{printf "%.0f", w*s}')
PH=$(awk -v h="$H" -v s="$SCALE" 'BEGIN{printf "%.0f", h*s}')
echo "OK  $OUT_ABS  ${W}x${H}css @${SCALE}x = ${PW}x${PH}px  ${SIZE} bytes (${KB}KB, base64後 約${B64}KB)"
