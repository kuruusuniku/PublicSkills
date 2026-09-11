#!/usr/bin/env bash
#
# make-images.sh — run-slack-html 用の図版生成エントリポイント
#
# Usage:
#   make-images.sh --spec <spec.json> --outdir <dir> [options]
#
# Options:
#   --spec <path>             必須。図版の仕様 JSON
#   --outdir <dir>            必須。出力先ディレクトリ (無ければ作る)
#   --engine auto|svg|codex   既定 auto
#                               auto : codex が使えれば codex、無ければ svg
#                               svg  : 同梱の svg-figures.py で描く (ネットワーク不要)
#                               codex: codex CLI の image_gen で生成する (要ログイン)
#   --target-bytes <N>        全画像の合計バイト下限 (既定 860000)
#   --max-bytes <N>           全画像の合計バイト上限 (既定 3000000)
#   -h, --help
#
# 出力:
#   <outdir>/fig-01.jpg, fig-02.jpg, ...   (spec の figures 順)
#   <outdir>/manifest.json                 (file / alt / bytes / engine と合計)
#   標準出力の最終行: TOTAL_BYTES=<n> ENGINE=<svg|codex>
#
# 注意: 実行開始時に <outdir> 内の fig-*.jpg / fig-*.png と manifest.json を
#       無条件に削除する (前回より figure が減ったときに古い画像を残さないため)。
#       この名前のファイルを別用途で置かないこと。
#
# 環境変数:
#   CODEX_LOGIN_TIMEOUT   codex login status の待ち時間(秒)。既定 20
#
# bash 3.2 互換 (macOS 標準)。

set -euo pipefail

SELF_NAME="make-images.sh"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SVG_FIGURES="$SCRIPT_DIR/svg-figures.py"
RASTERIZE="$SCRIPT_DIR/rasterize.sh"

SPEC=""
OUTDIR=""
ENGINE="auto"
TARGET_BYTES=860000
MAX_BYTES=3000000

# svg エンジンのバイト予算ループ: "長辺px:JPEG品質" を順に上げていく
TIERS="2048:88 2048:95 2560:95 3072:95 3072:98"

usage() {
  # 先頭の # コメントブロック (shebang の次行から、# 以外の行が来る手前まで) を出す。
  # 行数を固定するとヘッダ追記のたびに実装コードが漏れるため動的に取る。
  awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "$0"
}
log()  { echo "[$SELF_NAME] $*"; }
warn() { echo "[$SELF_NAME] WARN: $*" >&2; }
die()  { echo "[$SELF_NAME] ERROR: $*" >&2; exit 1; }

require_int() {
  case "$2" in
    ''|*[!0-9]*) die "$1 は正の整数で指定してください (指定値: $2)" ;;
  esac
}

while [ $# -gt 0 ]; do
  case "$1" in
    --spec)         SPEC="${2:-}"; shift 2 ;;
    --outdir)       OUTDIR="${2:-}"; shift 2 ;;
    --engine)       ENGINE="${2:-}"; shift 2 ;;
    --target-bytes) TARGET_BYTES="${2:-}"; shift 2 ;;
    --max-bytes)    MAX_BYTES="${2:-}"; shift 2 ;;
    -h|--help)      usage; exit 0 ;;
    *) echo "[$SELF_NAME] ERROR: 不明なオプション '$1'" >&2; usage >&2; exit 1 ;;
  esac
done

[ -n "$SPEC" ]   || { echo "[$SELF_NAME] ERROR: --spec <spec.json> は必須です" >&2; usage >&2; exit 1; }
[ -n "$OUTDIR" ] || { echo "[$SELF_NAME] ERROR: --outdir <dir> は必須です" >&2; usage >&2; exit 1; }
[ -f "$SPEC" ]   || die "spec ファイルが見つかりません: $SPEC"
require_int "--target-bytes" "$TARGET_BYTES"
require_int "--max-bytes" "$MAX_BYTES"
if [ "$MAX_BYTES" -lt "$TARGET_BYTES" ]; then
  # 上限が下限を下回る指定は矛盾しているが、動作は定義できる (上限側を優先し、
  # 下限に届かない旨を最後に警告する)。止めずに続ける。
  warn "--max-bytes ($MAX_BYTES) が --target-bytes ($TARGET_BYTES) より小さいです。上限を優先し、下限に届かなければ警告します"
fi
case "$ENGINE" in
  auto|svg|codex) ;;
  *) die "--engine は auto / svg / codex のいずれかです (指定値: $ENGINE)" ;;
esac

command -v python3 >/dev/null 2>&1 || \
  die "python3 が見つかりません。図版仕様の検証と SVG 生成に必要です (macOS: xcode-select --install / Linux: apt-get install -y python3)"
[ -f "$SVG_FIGURES" ] || die "svg-figures.py が見つかりません: $SVG_FIGURES"
[ -f "$RASTERIZE" ]   || die "rasterize.sh が見つかりません: $RASTERIZE"

# ---- spec の検証 (alt 必須 / figures 1件以上 / 未知 type はここで弾かれる) ----
if ! FIG_COUNT="$(python3 -B "$SVG_FIGURES" --spec "$SPEC" --count)"; then
  die "spec の検証に失敗しました: $SPEC (上のエラーを参照)"
fi
case "$FIG_COUNT" in
  ''|*[!0-9]*) die "figures の件数を取得できませんでした: $SPEC" ;;
esac

mkdir -p "$OUTDIR"
OUTDIR_ABS="$(cd "$OUTDIR" && pwd)"
SPEC_ABS="$(cd "$(dirname "$SPEC")" && pwd)/$(basename "$SPEC")"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/make-images.XXXXXX")"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT INT TERM

# ---- engine の決定 ----
# codex login status は認証サーバの応答待ちでハングしうる。macOS 標準に timeout(1) が
# 無いので、バックグラウンド実行 + ポーリング + kill で自前に打ち切る。
# 戻り値: 0=成功 / 1=失敗 / 124=タイムアウト
CODEX_LOGIN_TIMEOUT="${CODEX_LOGIN_TIMEOUT:-20}"

# 子プロセスを残さず落とす。set -m (プロセスグループ化) は使わない
# (監視モードのジョブ通知が stderr に出るため)。pgrep で子孫を辿る。
_kill_tree() {
  local p="$1" sig="$2" c
  if command -v pgrep >/dev/null 2>&1; then
    for c in $(pgrep -P "$p" 2>/dev/null); do _kill_tree "$c" "$sig"; done
  fi
  kill "-$sig" "$p" 2>/dev/null || true
}

run_with_timeout() {
  local secs="$1"; shift
  "$@" >/dev/null 2>&1 &
  local pid=$! waited=0 rc=0
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$waited" -ge "$secs" ]; then
      _kill_tree "$pid" TERM
      sleep 1
      _kill_tree "$pid" KILL
      wait "$pid" 2>/dev/null || true
      return 124
    fi
    sleep 1
    waited=$((waited + 1))
  done
  wait "$pid" || rc=$?
  return "$rc"
}

codex_login_state() {
  # ok / ng / timeout を標準出力に返す
  # 2>/dev/null は kill 時にシェルが出すジョブ終了通知を抑えるため
  local rc=0
  run_with_timeout "$CODEX_LOGIN_TIMEOUT" codex login status 2>/dev/null || rc=$?
  case "$rc" in
    0)   echo "ok" ;;
    124) echo "timeout" ;;
    *)   echo "ng" ;;
  esac
}

case "$ENGINE" in
  auto)
    if ! command -v codex >/dev/null 2>&1; then
      ENGINE="svg"
    else
      case "$(codex_login_state)" in
        ok) ENGINE="codex" ;;
        timeout)
          warn "codex login status が ${CODEX_LOGIN_TIMEOUT} 秒で応答しませんでした。svg エンジンで続行します
  (待ち時間を変えるには環境変数 CODEX_LOGIN_TIMEOUT を指定してください)"
          ENGINE="svg" ;;
        *) ENGINE="svg" ;;
      esac
    fi
    ;;
  codex)
    if ! command -v codex >/dev/null 2>&1; then
      die "--engine codex を指定しましたが codex コマンドが PATH にありません。
  導入例: npm i -g @openai/codex  (その後 codex login)
  ネットワーク不要の図版生成に切り替えるなら --engine svg を指定してください"
    fi
    case "$(codex_login_state)" in
      ok) ;;
      timeout)
        die "codex login status が ${CODEX_LOGIN_TIMEOUT} 秒以内に応答しませんでした。
  ネットワークか codex CLI の状態を確認してください (手動で \`codex login status\` を実行)。
  待ち時間を延ばすには環境変数 CODEX_LOGIN_TIMEOUT を指定してください。
  ネットワーク不要の図版生成に切り替えるなら --engine svg を指定してください" ;;
      *)
        die "--engine codex を指定しましたが codex にログインしていません (codex login status が失敗)。
  \`codex login\` で認証してから再実行してください。
  ネットワーク不要の図版生成に切り替えるなら --engine svg を指定してください" ;;
    esac
    ;;
esac

log "engine=$ENGINE figures=$FIG_COUNT outdir=$OUTDIR_ABS"

# ---- 既存の生成物を掃除 (前回より figure が減ったときに古い画像を残さない) ----
# 連番の範囲を決め打ちすると桁が増えたとき (fig-100 以降) に取り残すので glob で消す。
rm -f "$OUTDIR_ABS"/fig-*.jpg "$OUTDIR_ABS"/fig-*.png "$OUTDIR_ABS/manifest.json"

file_bytes() {
  # macOS / Linux 両対応
  wc -c < "$1" | tr -d ' '
}

RECORDS="$WORK/records.tsv"
: > "$RECORDS"

# ==========================================================================
# svg エンジン
# ==========================================================================
run_svg_engine() {
  local i pad svg
  i=0
  while [ "$i" -lt "$FIG_COUNT" ]; do
    pad="$(printf '%02d' $((i + 1)))"
    svg="$WORK/fig-$pad.svg"
    if ! python3 -B "$SVG_FIGURES" --spec "$SPEC_ABS" --index "$i" > "$svg"; then
      die "figures[$i] の SVG 生成に失敗しました (上のエラーを参照)"
    fi
    [ -s "$svg" ] || die "figures[$i] の SVG が空です"
    i=$((i + 1))
  done

  local tier px q stage total best_stage best_total best_tier tier_no
  best_stage=""; best_total=0; best_tier=""
  tier_no=0
  for tier in $TIERS; do
    tier_no=$((tier_no + 1))
    px="${tier%%:*}"
    q="${tier##*:}"
    stage="$WORK/stage-$tier_no"
    mkdir -p "$stage"
    : > "$stage/records.tsv"
    total=0

    i=0
    while [ "$i" -lt "$FIG_COUNT" ]; do
      pad="$(printf '%02d' $((i + 1)))"
      local line outfile fmt renderer bytes
      if ! line="$(bash "$RASTERIZE" --in "$WORK/fig-$pad.svg" \
                     --out "$stage/fig-$pad.jpg" --px "$px" --quality "$q" | tail -1)"; then
        die "fig-$pad のラスタライズに失敗しました (px=$px quality=$q)"
      fi
      outfile="$(printf '%s' "$line" | sed -n 's/^OUT=\(.*\) FORMAT=.*/\1/p')"
      fmt="$(printf '%s' "$line" | sed -n 's/.*FORMAT=\([a-zA-Z]*\).*/\1/p')"
      renderer="$(printf '%s' "$line" | sed -n 's/.*RENDERER=\([a-zA-Z]*\).*/\1/p')"
      [ -n "$outfile" ] && [ -f "$outfile" ] || \
        die "rasterize.sh の出力を解釈できませんでした: $line"
      bytes="$(file_bytes "$outfile")"
      total=$((total + bytes))
      printf '%d\t%s\t%s\t%s\t%s\n' "$i" "$(basename "$outfile")" "$bytes" "$fmt" "$renderer" \
        >> "$stage/records.tsv"
      i=$((i + 1))
    done

    log "tier $tier_no: ${px}px quality=$q -> ${total} bytes"

    if [ "$total" -gt "$MAX_BYTES" ]; then
      if [ -z "$best_stage" ]; then
        warn "1段目 (${px}px q${q}) で既に --max-bytes ($MAX_BYTES) を超えました (${total} bytes)。この結果をそのまま採用します"
        best_stage="$stage"; best_total="$total"; best_tier="${px}px/q${q}"
      else
        log "次の段 (${px}px q${q}) は --max-bytes ($MAX_BYTES) を超えるため採用せず、前の段で確定します"
      fi
      break
    fi

    best_stage="$stage"; best_total="$total"; best_tier="${px}px/q${q}"
    if [ "$total" -ge "$TARGET_BYTES" ]; then
      break
    fi
  done

  [ -n "$best_stage" ] || die "ラスタライズ結果が得られませんでした"

  cp "$best_stage"/fig-*.* "$OUTDIR_ABS"/
  cp "$best_stage/records.tsv" "$RECORDS"
  TOTAL_BYTES="$best_total"
  log "採用: $best_tier 合計 ${TOTAL_BYTES} bytes"

  if [ "$TOTAL_BYTES" -lt "$TARGET_BYTES" ]; then
    warn "合計 ${TOTAL_BYTES} bytes は --target-bytes ($TARGET_BYTES) に届きませんでした。
  品質段を上限まで上げても不足しています。本文の別セクションに合う図版を spec に足して
  再実行してください (無意味なパディングでサイズを稼がないこと)。"
  fi
}

# ==========================================================================
# codex エンジン
# ==========================================================================
run_codex_engine() {
  local auto_flags i pad prompt_file out_jpg
  # codex CLI 0.154 で --full-auto は廃止 (後継: --sandbox workspace-write)。
  # 廃止フラグを渡すと usage を出して即終了し、画像が 1 枚も保存されない。
  if codex exec --help 2>&1 | grep -q -- '--full-auto'; then
    auto_flags="--full-auto"
  else
    auto_flags="--sandbox workspace-write"
  fi

  local total=0
  i=0
  while [ "$i" -lt "$FIG_COUNT" ]; do
    pad="$(printf '%02d' $((i + 1)))"
    prompt_file="$WORK/prompt-$pad.txt"
    if ! python3 -B - "$SVG_FIGURES" "$SPEC_ABS" "$i" > "$prompt_file" <<'PYEOF'
import importlib.util, sys
mod_path, spec_path, idx = sys.argv[1], sys.argv[2], int(sys.argv[3])
s = importlib.util.spec_from_file_location("svgfig", mod_path)
m = importlib.util.module_from_spec(s)
s.loader.exec_module(m)
_, figures = m.load_spec(spec_path)
sys.stdout.write(m.build_prompt(figures[idx]))
PYEOF
    then
      die "figures[$i] のプロンプト生成に失敗しました"
    fi

    # codex への指示文 (image_gen の使い方 + 余計なファイルを作らせない制約) で包む
    local codex_prompt
    codex_prompt="$WORK/codex-prompt-$pad.txt"
    {
      echo "次の指示に従って画像を 1 枚生成してください。"
      echo
      echo "## 手順"
      echo "1. image_gen ツールで下記「プロンプト」の内容を high quality で生成する。"
      echo "2. 画像は image_gen が \$CODEX_HOME/generated_images/ に自動保存する。"
      echo "   保存先の指定・コピー・変換は不要 (呼び出し側が回収する)。"
      echo "3. 他のファイルは一切作らない。magick 等の変換も不要。"
      echo
      echo "## プロンプト"
      cat "$prompt_file"
      echo
      echo "## 制約"
      echo "- 失敗したら 1 回だけ image_gen をリトライしてよい。"
      echo "- 最終メッセージは OK もしくは NG <理由> の 1 行のみ。"
    } > "$codex_prompt"

    local png attempt max_attempts tmp_home
    png=""; attempt=0; max_attempts=3
    while [ "$attempt" -lt "$max_attempts" ]; do
      attempt=$((attempt + 1))
      tmp_home="$WORK/codex-home-$pad-$attempt"
      mkdir -p "$tmp_home/generated_images"
      # 既存の認証情報等は symlink で持ち込み、generated_images だけ隔離する
      local orig item name
      orig="${CODEX_HOME:-$HOME/.codex}"
      if [ -d "$orig" ]; then
        for item in "$orig"/* "$orig"/.[!.]*; do
          [ -e "$item" ] || continue
          name="$(basename "$item")"
          if [ "$name" = "generated_images" ]; then continue; fi
          ln -s "$item" "$tmp_home/$name" 2>/dev/null || true
        done
      fi

      log "codex: fig-$pad を生成中 (attempt $attempt/$max_attempts)"
      # shellcheck disable=SC2086
      # 作業ディレクトリは隔離した一時ディレクトリにする。codex が副産物のファイルを
      # 書いても outdir を汚さない (実測: outdir を渡すと png のコピーが残ることがある)。
      CODEX_HOME="$tmp_home" codex exec $auto_flags --skip-git-repo-check \
        -C "$tmp_home" -c model="gpt-5.5" -c model_reasoning_effort="medium" - \
        < "$codex_prompt" >/dev/null 2>&1 || true

      local w
      for w in 1 2 3; do
        png="$(find "$tmp_home/generated_images" -type f -name 'ig_*.png' -size +5k 2>/dev/null | head -1)"
        if [ -z "$png" ]; then
          png="$(find "$tmp_home/generated_images" -type f -name '*.png' -size +5k 2>/dev/null | head -1)"
        fi
        [ -n "$png" ] && break
        sleep 1
      done
      [ -n "$png" ] && break
      warn "codex: fig-$pad の image_gen 出力が見つかりません (attempt $attempt)"
    done

    if [ -z "$png" ]; then
      die "codex で fig-$pad の画像を生成できませんでした。
  \`codex login status\` を確認し、必要なら \`codex login\` で再認証してください。
  ネットワークを使わずに図版を作るなら --engine svg を指定してください。"
    fi

    local fmt
    if command -v magick >/dev/null 2>&1; then
      out_jpg="$OUTDIR_ABS/fig-$pad.jpg"
      magick "$png" -background white -alpha remove -alpha off -strip -quality 92 "$out_jpg" \
        >/dev/null 2>&1 || die "magick による JPEG 変換に失敗しました: $out_jpg"
      fmt="jpg"
    else
      out_jpg="$OUTDIR_ABS/fig-$pad.png"
      cp "$png" "$out_jpg"
      fmt="png"
      warn "magick が無いため PNG のまま出力します: $out_jpg"
    fi

    local bytes
    bytes="$(file_bytes "$out_jpg")"
    total=$((total + bytes))
    printf '%d\t%s\t%s\t%s\t%s\n' "$i" "$(basename "$out_jpg")" "$bytes" "$fmt" "codex" >> "$RECORDS"
    i=$((i + 1))
  done

  TOTAL_BYTES="$total"
  if [ "$TOTAL_BYTES" -lt "$TARGET_BYTES" ]; then
    warn "合計 ${TOTAL_BYTES} bytes は --target-bytes ($TARGET_BYTES) に届きませんでした。
  本文の別セクションに合う図版を spec に足して再実行してください。"
  fi
}

TOTAL_BYTES=0
if [ "$ENGINE" = "svg" ]; then
  run_svg_engine
else
  run_codex_engine
fi

# ---- manifest.json ----
python3 -B - "$SVG_FIGURES" "$SPEC_ABS" "$RECORDS" "$OUTDIR_ABS/manifest.json" \
         "$ENGINE" "$TOTAL_BYTES" "$TARGET_BYTES" <<'PYEOF'
import importlib.util, json, sys

mod_path, spec_path, rec_path, out_path, engine, total, target = sys.argv[1:8]
s = importlib.util.spec_from_file_location("svgfig", mod_path)
m = importlib.util.module_from_spec(s)
s.loader.exec_module(m)
palette, figures = m.load_spec(spec_path)

records = {}
with open(rec_path, encoding="utf-8") as fh:
    for line in fh:
        line = line.rstrip("\n")
        if not line:
            continue
        idx, name, nbytes, fmt, renderer = line.split("\t")
        records[int(idx)] = (name, int(nbytes), fmt, renderer)

entries, notes = [], []
for i, fig in enumerate(figures):
    name, nbytes, fmt, renderer = records[i]
    entry = {
        "index": i,
        "file": name,
        "type": fig["type"],
        "alt": fig["alt"],
        "bytes": nbytes,
        "engine": engine,
        "format": fmt,
        "renderer": renderer,
    }
    if fmt != "jpg":
        entry["note"] = "ImageMagick(magick) が無いため JPEG 変換せず PNG で出力した"
        notes.append("%s: JPEG 変換なし (magick 不在)" % name)
    entries.append(entry)

manifest = {
    "engine": engine,
    "palette": palette,
    "figure_count": len(entries),
    "total_bytes": int(total),
    "target_bytes": int(target),
    "target_met": int(total) >= int(target),
    "figures": entries,
}
if notes:
    manifest["notes"] = notes

with open(out_path, "w", encoding="utf-8") as fh:
    json.dump(manifest, fh, ensure_ascii=False, indent=2)
    fh.write("\n")
PYEOF

log "manifest: $OUTDIR_ABS/manifest.json"
echo "TOTAL_BYTES=$TOTAL_BYTES ENGINE=$ENGINE"
