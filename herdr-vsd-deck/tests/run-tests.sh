#!/bin/bash
# herdr-vsd-deck のテストをまとめて実行する。
#
#   bash herdr-vsd-deck/tests/run-tests.sh
#
# 必要なもの: Node.js 20+ (プラグイン) と Python 3.9+ (読み上げフック・インストーラ)。
# VSD Craft / herdr / VOICEVOX / Ollama は偽物で代用するので不要。

set -uo pipefail

TESTS_DIR="$(cd "$(dirname "$0")" && pwd)"
STATUS=0

echo "== plugin (node --test)"
node --test "$TESTS_DIR"/plugin/*.test.js || STATUS=1

echo "== voice hook (unittest)"
python3 -m unittest discover -s "$TESTS_DIR/voice" || STATUS=1

echo "== installer (unittest)"
python3 -m unittest discover -s "$TESTS_DIR/install" || STATUS=1

if [ "$STATUS" -eq 0 ]; then echo "ALL PASSED"; else echo "SOME TESTS FAILED"; fi
exit "$STATUS"
