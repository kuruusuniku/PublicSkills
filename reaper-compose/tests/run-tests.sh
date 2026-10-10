#!/bin/bash
# reaper-compose のテストをすべて実行する。
#
#   bash reaper-compose/tests/run-tests.sh
#
# 1. Lua の構文チェック (luac5.4 があれば)
# 2. ai_bridge.lua の単体テスト (モックの REAPER 上、lua5.4 があれば)
# 3. reaper_ai.py の単体テストと、モックの REAPER に常駐させたブリッジとの統合テスト
#
# REAPER 本体の API との整合は、実機で `reaper_ai.py selftest` を実行して確かめる。

set -uo pipefail
SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LUA="$(command -v lua5.4 || command -v lua || true)"
LUAC="$(command -v luac5.4 || command -v luac || true)"
status=0

if [ -n "$LUAC" ]; then
  for f in "$SKILL_DIR"/reaper/*.lua "$SKILL_DIR"/tests/lua/*.lua; do
    "$LUAC" -p "$f" || status=1
  done
  echo "lua syntax: checked"
else
  echo "lua syntax: SKIP (luac がありません)"
fi

if [ -n "$LUA" ]; then
  "$LUA" "$SKILL_DIR/tests/lua/test_bridge.lua" "$SKILL_DIR" || status=1
else
  echo "lua tests: SKIP (lua5.4 がありません)"
fi

PYTHON="${PYTHON:-python3}"
(cd "$SKILL_DIR" && "$PYTHON" -m unittest discover -s tests -p 'test_*.py') || status=1

bash -n "$SKILL_DIR/scripts/install.sh" || status=1

if [ "$status" = 0 ]; then echo "ALL PASSED"; else echo "SOME TESTS FAILED"; fi
exit "$status"
