#!/usr/bin/env bash
#
# run-slack-html/scripts/verify.sh — 機械検証
#
# Usage: verify.sh <path/to/*-slack-mobile.html>
#
# 単一ファイルHTMLが Slack モバイル向けの絶対要件を満たしているか確認する。
# 終了コード: 0 = 全PASS, 1 = 1つ以上FAIL

set -uo pipefail

FILE="${1:-}"
if [[ -z "$FILE" || ! -f "$FILE" ]]; then
  echo "Usage: $0 <path/to/*-slack-mobile.html>" >&2
  exit 2
fi

FAIL=0
pass() { echo "  PASS  $1"; }
fail() { echo "  FAIL  $1"; FAIL=1; }
warn() { echo "  WARN  $1 (要目視確認)"; }

echo "=== run-slack-html verify: $FILE ==="

# 1. ファイル名
base="$(basename "$FILE")"
if [[ "$base" == *-slack-mobile.html ]]; then
  pass "ファイル名が *-slack-mobile.html で終わっている"
else
  fail "ファイル名が *-slack-mobile.html で終わっていない ($base)"
fi

# 2. UTF-8宣言
if grep -qi 'charset="utf-8"' "$FILE"; then
  pass "charset=\"utf-8\" 宣言あり"
else
  fail "charset=\"utf-8\" 宣言が見つからない"
fi

# 3. サイズ
size=$(wc -c < "$FILE" | tr -d ' ')
limit=1048576
if [[ "$size" -gt "$limit" ]]; then
  mb=$(awk -v s="$size" 'BEGIN{printf "%.2f", s/1024/1024}')
  pass "サイズ ${size} bytes (${mb} MB) は ${limit} bytes を超えている"
else
  mb=$(awk -v s="$size" 'BEGIN{printf "%.2f", s/1024/1024}')
  fail "サイズ ${size} bytes (${mb} MB) が ${limit} bytes 以下"
fi

# 4. 埋め込み画像数 + base64整合性
img_count=$(grep -o 'data:image/[a-zA-Z]*;base64,' "$FILE" | wc -l | tr -d ' ')
echo "  INFO  埋め込み画像(data URI)数: ${img_count}"
if [[ "$img_count" -eq 0 ]]; then
  fail "data:image base64 埋め込みが1件も無い"
else
  python3 - "$FILE" <<'PYEOF'
import base64, re, sys

path = sys.argv[1]
html = open(path, "r", encoding="utf-8", errors="replace").read()
pattern = re.compile(r'data:image/[a-zA-Z]+;base64,([A-Za-z0-9+/=]+)')
ok = 0
bad = 0
for m in pattern.finditer(html):
    b64 = m.group(1)
    try:
        base64.b64decode(b64, validate=True)
        ok += 1
    except Exception:
        bad += 1
print(f"  INFO  base64デコード検証: OK={ok} NG={bad}")
sys.exit(1 if bad > 0 else 0)
PYEOF
  if [[ $? -eq 0 ]]; then
    pass "すべてのbase64ブロックが正しくデコードできる"
  else
    fail "デコードできないbase64ブロックがある(破損の疑い)"
  fi
fi

# 5. 禁止API
forbidden_pattern='fetch\(|localStorage|sessionStorage|AudioContext|getContext\(|new Blob\(|XMLHttpRequest'
if grep -qE "$forbidden_pattern" "$FILE"; then
  echo "  FAIL  禁止API/機能への依存が見つかった:"
  grep -nE "$forbidden_pattern" "$FILE" | sed 's/^/        /' | head -10
  FAIL=1
else
  pass "fetch/localStorage/AudioContext/Canvas/Blob/XHR への依存なし"
fi

# 6. 外部リソース参照
external_pattern='(href|src)="https?://|url\(https?://'
if grep -qE "$external_pattern" "$FILE"; then
  echo "  FAIL  外部リソース参照が見つかった:"
  grep -nE "$external_pattern" "$FILE" | sed 's/^/        /' | head -10
  FAIL=1
else
  pass "外部フォント/CSS/画像の参照なし"
fi

# 7. ページ全体固定の疑い (height:100% + overflow:hidden が同居)
if grep -qiE 'height:\s*100%' "$FILE" && grep -qiE 'overflow:\s*hidden' "$FILE"; then
  warn "height:100% と overflow:hidden が両方出現する — ページ全体固定になっていないか確認"
else
  pass "height:100%+overflow:hidden によるページ全体固定は検出されない"
fi

# 8. details/summary の有無 (情報のみ)
if grep -qi '<details' "$FILE"; then
  echo "  INFO  <details>/<summary> を使用している(開閉要素はJS不要な実装)"
else
  echo "  INFO  <details> は未使用(このHTMLに開閉要素が無ければ問題なし)"
fi

# 9. display:none の使用 (JS前提で隠している疑い)
dn_count=$(grep -oiE 'display:\s*none' "$FILE" | wc -l | tr -d ' ')
if [[ "$dn_count" -gt 0 ]]; then
  warn "display:none が ${dn_count} 箇所ある — <noscript> 外でJS前提の非表示に使っていないか目視確認"
else
  pass "display:none は使用されていない"
fi

echo "=== 結果: $([[ $FAIL -eq 0 ]] && echo 'ALL PASS' || echo 'FAIL あり') ==="
exit $FAIL
