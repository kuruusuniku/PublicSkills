#!/bin/bash
# Adversarial test suite for the run-slack-html image engine.
#
# These tests are derived from SPEC.md, not from the implementation.  Their job
# is to falsify the implementation, not to confirm it.
#
# Usage:
#   run-tests.sh [--fast] [--wait <seconds>] [--only <group letters>]
#
#   --fast          skip the groups that rasterize images (F G H I)
#   --wait N        wait up to N seconds for the implementation files to appear
#   --only ABC      run only the listed groups (default: all)
#
# Exit status: 0 when every test passes, 1 when any test fails.
# WARN lines are spec gaps / quality concerns that do not fail the suite.

set -uo pipefail

TESTS_DIR="$(cd "$(dirname "$0")" && pwd)"
SKILL_DIR="$(cd "$TESTS_DIR/.." && pwd)"
REPO_DIR="$(cd "$SKILL_DIR/.." && pwd)"
# RSH_SCRIPTS_DIR lets the suite be pointed at a stub implementation while
# self-checking that the tests can actually fail.
SCRIPTS_DIR="${RSH_SCRIPTS_DIR:-$SKILL_DIR/scripts}"
MAKE_IMAGES="$SCRIPTS_DIR/make-images.sh"
SVG_FIGURES="$SCRIPTS_DIR/svg-figures.py"
RASTERIZE="$SCRIPTS_DIR/rasterize.sh"
FIX="$TESTS_DIR/fixtures"
LIB="$TESTS_DIR/lib"

FAST=0
WAIT_SECS=0
ONLY="ABCDEFGHI"
while [ $# -gt 0 ]; do
  case "$1" in
    --fast) FAST=1; shift ;;
    --wait) WAIT_SECS="$2"; shift 2 ;;
    --only) ONLY="$2"; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
[ "$FAST" -eq 1 ] && ONLY="$(printf '%s' "$ONLY" | tr -d 'FGHI')"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/rsh-tests.XXXXXX")"
cleanup() { chmod -R u+rwX "$WORK" 2>/dev/null; rm -rf "$WORK"; }
trap cleanup EXIT

PASS=0; FAIL=0; WARN=0; SKIP=0
FAIL_LIST=""; WARN_LIST=""
CUR=""; TERR=""
RC=0; OUT=""; ERR=""
MI_TIMEOUT=420

# ---------------------------------------------------------------- reporting --
group() { printf '\n=== %s\n' "$1"; }
t()    { CUR="$1"; TERR=""; }
bad()  { TERR="$TERR
        $1"; }
endt() {
  if [ -n "$TERR" ]; then
    FAIL=$((FAIL + 1))
    printf 'FAIL  %s%s\n' "$CUR" "$TERR"
    FAIL_LIST="$FAIL_LIST
  - $CUR"
  else
    PASS=$((PASS + 1))
    printf 'PASS  %s\n' "$CUR"
  fi
  CUR=""; TERR=""
}
warn() {
  WARN=$((WARN + 1))
  printf 'WARN  %s — %s\n' "${CUR:-general}" "$1"
  WARN_LIST="$WARN_LIST
  - ${CUR:-general}: $1"
}
skip() { SKIP=$((SKIP + 1)); printf 'SKIP  %s — %s\n' "${CUR:-general}" "$1"; CUR=""; TERR=""; }
want() { case "$ONLY" in *"$1"*) return 0 ;; *) return 1 ;; esac; }

# ------------------------------------------------------------------ helpers --
TIMEOUT_BIN=""
if command -v gtimeout >/dev/null 2>&1; then TIMEOUT_BIN="gtimeout"
elif command -v timeout >/dev/null 2>&1; then TIMEOUT_BIN="timeout"; fi

run_timed() {
  local secs="$1"; shift
  if [ -n "$TIMEOUT_BIN" ]; then
    # -k: SIGTERM alone is not enough. A bash script blocked on a foreground
    # child defers the signal until that child exits, so a hung Chrome makes the
    # whole tree unkillable without a follow-up SIGKILL.
    "$TIMEOUT_BIN" -k 5 "$secs" "$@"
  else
    perl -e '
      my $s = shift;
      my $pid = fork();
      if (!defined $pid) { exit 125; }
      if ($pid == 0) { setpgrp(0, 0); exec @ARGV; exit 127; }
      $SIG{ALRM} = sub { kill(-9, $pid); waitpid($pid, 0); exit 124; };
      alarm $s;
      waitpid($pid, 0);
      exit($? >> 8);
    ' "$secs" "$@"
  fi
}

# Strip every PATH entry that provides `codex`, so tests control availability.
sanitize_path() {
  local p="$1" found d
  while :; do
    found="$(PATH="$p" command -v codex 2>/dev/null)"
    [ -z "$found" ] && break
    d="$(dirname "$found")"
    p="$(printf '%s' "$p" | tr ':' '\n' | grep -v -x -F "$d" | paste -sd: -)"
    [ -z "$p" ] && break
  done
  printf '%s' "$p"
}

# run_mi <tag> <PATH to use> [args...]  -> sets RC, OUT, ERR, and MI_TMP
run_mi() {
  local tag="$1"; shift
  local usepath="$1"; shift
  OUT="$WORK/$tag.out"; ERR="$WORK/$tag.err"
  MI_TMP="$WORK/tmp-$tag"
  rm -rf "$MI_TMP"; mkdir -p "$MI_TMP"
  local oldpath="$PATH" oldtmp="${TMPDIR:-}"
  PATH="$usepath"; TMPDIR="$MI_TMP"; export TMPDIR
  run_timed "$MI_TIMEOUT" /bin/bash "$MAKE_IMAGES" "$@" >"$OUT" 2>"$ERR"
  RC=$?
  PATH="$oldpath"
  if [ -n "$oldtmp" ]; then TMPDIR="$oldtmp"; export TMPDIR; else unset TMPDIR; fi
  [ "$RC" -eq 124 ] && bad "timed out after ${MI_TIMEOUT}s"
}

errsnip() { head -c 400 "$ERR" 2>/dev/null | LC_ALL=C tr '\n' ' '; }
outsnip() { head -c 400 "$OUT" 2>/dev/null | LC_ALL=C tr '\n' ' '; }

expect_rc0() {
  [ "$RC" -eq 0 ] || bad "exit=$RC expected 0 | stderr: $(errsnip)"
}
expect_rc_nonzero() {
  [ "$RC" -ne 0 ] || bad "exit=0, expected non-zero (${1:-error case}) | stdout: $(outsnip)"
  [ "$RC" -ge 124 ] && bad "exit=$RC looks like a crash/timeout, not a clean error"
}
expect_stderr_nonempty() {
  [ -s "$ERR" ] || bad "nothing was written to stderr to explain the failure"
}
expect_no_total() {
  if grep -q 'TOTAL_BYTES=' "$OUT" 2>/dev/null; then
    bad "printed TOTAL_BYTES on a run that must fail: $(grep -m1 TOTAL_BYTES "$OUT")"
  fi
}
expect_no_traceback() {
  if grep -q 'Traceback (most recent call last)' "$ERR" 2>/dev/null; then
    warn "a raw Python traceback leaks to stderr instead of a readable message"
  fi
}
# last stdout line must be exactly "TOTAL_BYTES=<n> ENGINE=<svg|codex>"
TOTAL_BYTES=0; ENGINE_SEEN=""
expect_total_line() {
  TOTAL_BYTES=0; ENGINE_SEEN=""
  local last count
  last="$(tail -n 1 "$OUT")"
  count="$(grep -c 'TOTAL_BYTES=' "$OUT")"
  if [ "$count" -ne 1 ]; then
    bad "expected exactly 1 TOTAL_BYTES line on stdout, found $count"
  fi
  if printf '%s' "$last" | grep -Eq '^TOTAL_BYTES=[0-9]+ ENGINE=(svg|codex)$'; then
    TOTAL_BYTES="$(printf '%s' "$last" | sed -E 's/^TOTAL_BYTES=([0-9]+).*/\1/')"
    ENGINE_SEEN="$(printf '%s' "$last" | sed -E 's/.*ENGINE=([a-z]+)$/\1/')"
  else
    bad "last stdout line is not 'TOTAL_BYTES=<n> ENGINE=<svg|codex>': $(printf '%s' "$last" | head -c 200)"
  fi
  if [ -n "${1:-}" ] && [ -n "$ENGINE_SEEN" ] && [ "$ENGINE_SEEN" != "$1" ]; then
    bad "ENGINE=$ENGINE_SEEN, expected ENGINE=$1"
  fi
}
check_manifest() { # <outdir> <spec> [extra args...]
  local outdir="$1" spec="$2"; shift 2
  local res
  res="$(python3 "$LIB/check_manifest.py" --manifest "$outdir/manifest.json" \
          --spec "$spec" --outdir "$outdir" "$@" 2>&1)"
  if [ $? -ne 0 ]; then
    bad "manifest check: $(printf '%s' "$res" | grep '^ERROR' | head -c 900 | LC_ALL=C tr '\n' '|')"
  fi
}
check_no_temp_leak() {
  local leftovers
  leftovers="$(ls -A "$MI_TMP" 2>/dev/null)"
  if [ -n "$leftovers" ]; then
    bad "temporary files were left behind in TMPDIR: $(printf '%s' "$leftovers" | LC_ALL=C tr '\n' ' ')"
  fi
}

# --------------------------------------------------------- environment prep --
SAFE_PATH="$(sanitize_path "$PATH")"
[ -z "$SAFE_PATH" ] && SAFE_PATH="/usr/bin:/bin:/usr/sbin:/sbin"

mkdir -p "$WORK/bin-codexfail" "$WORK/bin-codexok"
cat > "$WORK/bin-codexfail/codex" <<'EOF'
#!/bin/bash
echo "codex-shim called: $*" >> "${CODEX_LOG:-/dev/null}"
echo "not logged in" >&2
exit 1
EOF
cat > "$WORK/bin-codexok/codex" <<'EOF'
#!/bin/bash
echo "codex-shim called: $*" >> "${CODEX_LOG:-/dev/null}"
if [ "${1:-}" = "login" ] && [ "${2:-}" = "status" ]; then
  echo "Logged in"
  exit 0
fi
echo "codex-shim: refusing to actually generate anything" >&2
exit 1
EOF
chmod +x "$WORK/bin-codexfail/codex" "$WORK/bin-codexok/codex"
PATH_NOCODEX="$SAFE_PATH"
PATH_CODEXFAIL="$WORK/bin-codexfail:$SAFE_PATH"
PATH_CODEXOK="$WORK/bin-codexok:$SAFE_PATH"

HAVE_MAGICK=0
command -v magick >/dev/null 2>&1 && HAVE_MAGICK=1
REQ_JPEG=""
[ "$HAVE_MAGICK" -eq 1 ] && REQ_JPEG="--require-jpeg"

# ------------------------------------------------- wait for implementation --
waited=0
while [ ! -f "$MAKE_IMAGES" ] || [ ! -f "$SVG_FIGURES" ] || [ ! -f "$RASTERIZE" ]; do
  if [ "$waited" -ge "$WAIT_SECS" ]; then break; fi
  printf 'waiting for implementation files... (%ss/%ss)\n' "$waited" "$WAIT_SECS"
  sleep 10
  waited=$((waited + 10))
done

printf 'suite: run-slack-html image engine\n'
printf 'scripts: %s\n' "$SCRIPTS_DIR"
printf 'groups: %s   magick=%s  chrome=%s\n' "$ONLY" "$HAVE_MAGICK" \
  "$( [ -x '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' ] && echo yes || echo no)"

# =========================================================== A: static checks =
if want A; then
group "A. static / packaging"

t "A1 all three scripts exist and are executable"
  for f in "$MAKE_IMAGES" "$SVG_FIGURES" "$RASTERIZE"; do
    [ -f "$f" ] || bad "missing: $f"
  done
  for f in "$MAKE_IMAGES" "$RASTERIZE"; do
    [ -f "$f" ] && [ ! -x "$f" ] && bad "not executable: $f"
  done
endt

if [ ! -f "$MAKE_IMAGES" ]; then
  printf '\nImplementation not present yet; aborting after static group.\n'
  printf '\nPASS=%s FAIL=%s WARN=%s SKIP=%s\n' "$PASS" "$FAIL" "$WARN" "$SKIP"
  exit 1
fi

t "A2 shell scripts use 'set -euo pipefail' (spec: 動作環境)"
  for f in "$MAKE_IMAGES" "$RASTERIZE"; do
    grep -Eq '^[[:space:]]*set[[:space:]]+-euo[[:space:]]+pipefail' "$f" \
      || bad "$(basename "$f") has no 'set -euo pipefail'"
  done
endt

t "A3 no bash-4-only syntax (spec: bash 3.2 で動くこと)"
  : > "$WORK/b4.txt"
  for f in "$MAKE_IMAGES" "$RASTERIZE"; do
    grep -nE 'declare[[:space:]]+-A|local[[:space:]]+-A|readarray|mapfile|\$\{[A-Za-z_][A-Za-z0-9_]*\^\^|\$\{[A-Za-z_][A-Za-z0-9_]*,,' "$f" \
      | sed "s|^|$(basename "$f"):|" >> "$WORK/b4.txt"
  done
  [ -s "$WORK/b4.txt" ] && bad "bash4 construct: $(LC_ALL=C tr '\n' '|' < "$WORK/b4.txt")"
endt

t "A4 scripts parse under /bin/bash 3.2 and python3"
  for f in "$MAKE_IMAGES" "$RASTERIZE"; do
    /bin/bash -n "$f" 2>"$WORK/syn.txt" || bad "$(basename "$f"): $(head -c 200 "$WORK/syn.txt")"
  done
  # keep __pycache__ out of the implementation directory
  ( PYTHONPYCACHEPREFIX="$WORK/pycache"; export PYTHONPYCACHEPREFIX
    python3 -m py_compile "$SVG_FIGURES" ) 2>"$WORK/pyc.txt" \
    || bad "svg-figures.py does not compile: $(head -c 300 "$WORK/pyc.txt")"
endt

t "A5 svg-figures.py imports standard library only (spec: 外部パッケージ禁止)"
  python3 - "$SVG_FIGURES" <<'PY' > "$WORK/imports.txt" 2>&1
import ast, sys
src = open(sys.argv[1], encoding="utf-8").read()
tree = ast.parse(src)
std = set(getattr(sys, "stdlib_module_names", ()))
mods = set()
for n in ast.walk(tree):
    if isinstance(n, ast.Import):
        for a in n.names:
            mods.add(a.name.split(".")[0])
    elif isinstance(n, ast.ImportFrom):
        if n.level == 0 and n.module:
            mods.add(n.module.split(".")[0])
bad = sorted(m for m in mods if std and m not in std)
print("NONSTD:" + ",".join(bad))
PY
  nonstd="$(sed -n 's/^NONSTD://p' "$WORK/imports.txt")"
  [ -n "$nonstd" ] && bad "non-stdlib imports: $nonstd"
  grep -q 'NONSTD:' "$WORK/imports.txt" || bad "import scan failed: $(head -c 200 "$WORK/imports.txt")"
endt

t "A6 no fixed /tmp paths (spec 禁止事項: mktemp -d を使う)"
  grep -nE '/tmp/[A-Za-z0-9_.*$-]' "$MAKE_IMAGES" "$RASTERIZE" "$SVG_FIGURES" 2>/dev/null \
    | grep -v mktemp > "$WORK/tmp.txt"
  [ -s "$WORK/tmp.txt" ] && bad "literal /tmp path: $(head -c 300 "$WORK/tmp.txt" | LC_ALL=C tr '\n' '|')"
endt

t "A7 no hardcoded secrets (global security rule)"
  grep -nEi '(sk-[A-Za-z0-9]{16,}|api[_-]?key[[:space:]]*=[[:space:]]*["'\''][^"'\'']{8,}|AKIA[0-9A-Z]{16}|Bearer [A-Za-z0-9._-]{20,})' \
    "$MAKE_IMAGES" "$RASTERIZE" "$SVG_FIGURES" > "$WORK/sec.txt" 2>/dev/null
  [ -s "$WORK/sec.txt" ] && bad "possible hardcoded secret: $(head -c 200 "$WORK/sec.txt")"
endt

t "A8 no eval on user input (spec 禁止事項)"
  grep -nE '(^|[^A-Za-z_])eval[[:space:]]' "$MAKE_IMAGES" "$RASTERIZE" > "$WORK/eval.txt" 2>/dev/null
  [ -s "$WORK/eval.txt" ] && warn "eval used, review by hand: $(head -c 200 "$WORK/eval.txt")"
  grep -nE '\beval\(|\bexec\(' "$SVG_FIGURES" > "$WORK/pyeval.txt" 2>/dev/null
  [ -s "$WORK/pyeval.txt" ] && bad "python eval/exec: $(head -c 200 "$WORK/pyeval.txt")"
endt

t "A9 verify.sh is untouched (spec: 既存の verify.sh は変更しない)"
  if git -C "$REPO_DIR" rev-parse >/dev/null 2>&1; then
    git -C "$REPO_DIR" diff --quiet -- run-slack-html/scripts/verify.sh \
      || bad "run-slack-html/scripts/verify.sh has uncommitted modifications"
  else
    skip "not a git repo"
  fi
[ -n "$CUR" ] && endt
fi

# ======================================================= B: CLI argument contract
if want B; then
group "B. make-images.sh argument handling"

t "B1 --help exits 0 and documents every documented option"
  run_mi b1 "$PATH_NOCODEX" --help
  expect_rc0
  for o in --spec --outdir --engine --target-bytes --max-bytes; do
    grep -q -- "$o" "$OUT" || bad "--help output does not mention $o"
  done
  grep -qi 'usage' "$OUT" || bad "--help output has no Usage line"
endt

t "B2 no arguments at all is an error naming what is missing"
  run_mi b2 "$PATH_NOCODEX"
  expect_rc_nonzero "no args"
  expect_stderr_nonempty
  expect_no_total
  grep -q -- '--spec' "$ERR" || bad "the error does not tell the user that --spec is required"
endt

t "B3 --spec without --outdir is an error naming --outdir"
  run_mi b3 "$PATH_NOCODEX" --spec "$FIX/one-hero.json"
  expect_rc_nonzero "missing --outdir"; expect_no_total
  grep -q -- '--outdir' "$ERR" \
    || bad "the error does not mention --outdir: $(errsnip)"
endt

t "B4 --outdir without --spec is an error naming --spec"
  run_mi b4 "$PATH_NOCODEX" --outdir "$WORK/b4out"
  expect_rc_nonzero "missing --spec"; expect_no_total
  grep -q -- '--spec' "$ERR" \
    || bad "the error does not mention --spec: $(errsnip)"
  [ -d "$WORK/b4out" ] && warn "outdir was created even though the run failed on arguments"
endt

t "B5 unknown option is rejected, not ignored"
  run_mi b5 "$PATH_NOCODEX" --spec "$FIX/one-hero.json" --outdir "$WORK/b5out" --bogus-flag
  expect_rc_nonzero "unknown option"; expect_no_total
endt

t "B6 --spec pointing at a nonexistent file is an error naming the path"
  run_mi b6 "$PATH_NOCODEX" --spec "$WORK/does-not-exist.json" --outdir "$WORK/b6out"
  expect_rc_nonzero "missing spec file"
  expect_stderr_nonempty
  grep -q 'does-not-exist.json' "$ERR" "$OUT" 2>/dev/null \
    || warn "error message does not name the missing spec file"
  expect_no_traceback
endt

t "B7 --engine with an unknown value is rejected"
  run_mi b7 "$PATH_NOCODEX" --spec "$FIX/one-hero.json" --outdir "$WORK/b7out" --engine dalle
  expect_rc_nonzero "unknown engine"; expect_no_total
  grep -qi 'engine' "$ERR" \
    || bad "the error does not say the --engine value was the problem: $(errsnip)"
  grep -q 'dalle\|svg' "$ERR" \
    || bad "the error names neither the bad value nor the accepted values: $(errsnip)"
endt

t "B8 --target-bytes must be numeric"
  run_mi b8 "$PATH_NOCODEX" --spec "$FIX/one-hero.json" --outdir "$WORK/b8out" --target-bytes abc
  expect_rc_nonzero "non-numeric --target-bytes"; expect_no_total
endt

t "B9 --max-bytes must be numeric"
  run_mi b9 "$PATH_NOCODEX" --spec "$FIX/one-hero.json" --outdir "$WORK/b9out" --max-bytes -5
  expect_rc_nonzero "negative --max-bytes"; expect_no_total
endt

t "B10 an option given without its value does not swallow the next option"
  run_mi b10 "$PATH_NOCODEX" --spec --outdir "$WORK/b10out"
  expect_rc_nonzero "--spec with no value"
  expect_no_total
endt

t "B12 --help prints only the documented usage, never implementation code"
  for sc in "$MAKE_IMAGES" "$RASTERIZE"; do
    n="$(basename "$sc")"
    OUT="$WORK/b12-$n.out"; ERR="$WORK/b12-$n.err"
    run_timed 60 /bin/bash "$sc" --help >"$OUT" 2>"$ERR"
    rc=$?
    [ "$rc" -ne 0 ] && bad "$n --help exited $rc"
    # Anything that only makes sense as code means the header slice ran past the
    # end of the comment block.
    if grep -nE '^[[:space:]]*(set -[euo]|case .*\bin$|while \[|if \[|elif \[|fi$|esac$|done$|\}$|[a-z_]+\(\)|export |local |trap |shift|exit [0-9])' "$OUT" > "$WORK/b12-$n.leak"; then
      bad "$n --help leaks implementation code: $(head -2 "$WORK/b12-$n.leak" | LC_ALL=C tr '\n' '|' | head -c 200)"
    fi
    grep -q '#!' "$OUT" && bad "$n --help output contains a shebang line"
  done
endt

t "B11 --target-bytes above --max-bytes terminates (warn or error, never hang)"
  run_mi b11 "$PATH_NOCODEX" --spec "$FIX/one-hero.json" --outdir "$WORK/b11out" \
    --target-bytes 5000000 --max-bytes 100000
  [ "$RC" -ge 124 ] && bad "exit=$RC (hang/crash) for target>max"
  [ "$RC" -gt 1 ] && [ "$RC" -lt 124 ] && warn "exit=$RC for target>max; 0 (warn) or 1 (error) expected"
endt
fi

# ========================================================= C: spec validation =
if want C; then
group "C. spec JSON validation"

# <tag> <fixture> <why> <regex the error message must match>
# The message check matters: without it a guard can be "passing" only because
# some unrelated crash further downstream also exits non-zero, after the work
# has already been done.
c_expect_fail() {
  t "$3"
  run_mi "$1" "$PATH_NOCODEX" --spec "$FIX/$2" --outdir "$WORK/$1out"
  expect_rc_nonzero "$3"
  expect_stderr_nonempty
  expect_no_total
  # For a bad spec file the user must get a readable message, not a Python
  # traceback: a traceback also means the guard that should have caught this
  # was never reached.
  if grep -q 'Traceback (most recent call last)' "$ERR" 2>/dev/null; then
    bad "a raw Python traceback is shown instead of a readable error: $(grep -m1 -A2 'Traceback' "$ERR" | LC_ALL=C tr '\n' ' ' | head -c 200)"
  fi
  if [ -n "${4:-}" ]; then
    grep -Eq "$4" "$ERR" \
      || bad "the error does not identify the problem (expected something matching /$4/): $(errsnip)"
  fi
  if [ -d "$WORK/${1}out" ]; then
    # NB: one `ls` over two globs returns non-zero whenever either glob misses,
    # which would mask a directory that does contain images.
    for g in "$WORK/${1}out"/fig-*.jpg "$WORK/${1}out"/fig-*.png; do
      [ -f "$g" ] && bad "images were produced despite the spec being invalid: $(basename "$g")"
    done
    [ -f "$WORK/${1}out/manifest.json" ] \
      && bad "manifest.json was written despite the spec being invalid"
  fi
  endt
}

c_expect_fail c1 empty-figures.json    "C1 figures: [] is an error (spec: figures は 1 件以上)" "figures"
c_expect_fail c2 no-figures-key.json   "C2 missing 'figures' key is an error" "figures"
c_expect_fail c3 not-object.json       "C3 top-level array is an error" "figures|object|オブジェクト|トップレベル"
c_expect_fail c4 unknown-type.json     "C4 unknown figure type is an error (黙って無視しない)" "type|pyramid"
c_expect_fail c5 missing-alt.json      "C5 a figure without alt is an error (alt は全 figure で必須)" "alt"
c_expect_fail c6 broken.json           "C6 malformed JSON is an error" "JSON|json"

t "C7 an empty alt string is treated as a missing alt"
  run_mi c7 "$PATH_NOCODEX" --spec "$FIX/empty-alt.json" --outdir "$WORK/c7out"
  if [ "$RC" -eq 0 ]; then
    warn 'alt:"" is accepted; run-slack-html requires a real alt on every img'
  fi
  expect_no_traceback
endt

t "C8 empty steps/items arrays do not produce a broken figure"
  run_mi c8 "$PATH_NOCODEX" --spec "$FIX/empty-items.json" --outdir "$WORK/c8out"
  if [ "$RC" -eq 0 ]; then
    warn "empty steps/items accepted; check the figures are not blank (spec is silent)"
    [ -f "$WORK/c8out/manifest.json" ] || bad "exit 0 but no manifest.json"
  else
    [ "$RC" -ge 124 ] && bad "exit=$RC (crash/hang) on empty steps/items"
  fi
  expect_no_traceback
endt

t "C9 figures missing their type-specific fields fail cleanly"
  run_mi c9 "$PATH_NOCODEX" --spec "$FIX/missing-fields.json" --outdir "$WORK/c9out"
  [ "$RC" -ge 124 ] && bad "exit=$RC (crash/hang) on figures missing required fields"
  if [ "$RC" -eq 0 ]; then
    warn "flow without steps / stat without value / compare without left is accepted silently"
  fi
  expect_no_traceback
endt

t "C10 an unknown palette name does not crash"
  run_mi c10 "$PATH_NOCODEX" --spec "$FIX/bogus-palette.json" --outdir "$WORK/c10out"
  [ "$RC" -ge 124 ] && bad "exit=$RC (crash/hang) on unknown palette"
  expect_no_traceback
  if [ "$RC" -eq 0 ]; then
    warn "unknown palette silently falls back to the default instead of erroring"
  fi
endt

t "C11 a directory passed as --spec is rejected"
  run_mi c11 "$PATH_NOCODEX" --spec "$FIX" --outdir "$WORK/c11out"
  expect_rc_nonzero "--spec is a directory"
  expect_no_traceback
endt
fi

# ======================================================== D: svg-figures.py ===
if want D; then
group "D. svg-figures.py"

svg_run() { # <tag> [args...]
  OUT="$WORK/$1.svg"; ERR="$WORK/$1.svgerr"; shift
  run_timed 60 python3 "$SVG_FIGURES" "$@" >"$OUT" 2>"$ERR"
  RC=$?
}

t "D1 index 0 (hero) is a well-formed 1200x1200 SVG with a font fallback"
  svg_run d1 --spec "$FIX/basic5.json" --index 0
  expect_rc0
  if [ "$RC" -eq 0 ]; then
    python3 "$LIB/check_svg.py" --svg "$OUT" --expect-width 1200 --expect-height 1200 \
      --require-font-fallback --require-text "Slack で 1MiB 超" > "$WORK/d1.chk" 2>&1 \
      || bad "$(LC_ALL=C tr '\n' '|' < "$WORK/d1.chk" | head -c 600)"
    [ -s "$ERR" ] && warn "svg-figures.py wrote to stderr on a successful run: $(head -c 200 "$ERR")"
  fi
endt

t "D2 compare uses a 1800x1200 viewBox (spec: compare のみ 3:2)"
  svg_run d2 --spec "$FIX/basic5.json" --index 2
  expect_rc0
  if [ "$RC" -eq 0 ]; then
    python3 "$LIB/check_svg.py" --svg "$OUT" --expect-width 1800 --expect-height 1200 \
      --require-text "Before" --require-text "After" > "$WORK/d2.chk" 2>&1 \
      || bad "$(LC_ALL=C tr '\n' '|' < "$WORK/d2.chk" | head -c 600)"
  fi
endt

t "D3 every figure type renders well-formed SVG"
  i=0
  while [ "$i" -lt 5 ]; do
    svg_run "d3_$i" --spec "$FIX/basic5.json" --index "$i"
    if [ "$RC" -ne 0 ]; then
      bad "index $i exited $RC: $(head -c 200 "$ERR")"
    else
      w=1200; [ "$i" -eq 2 ] && w=1800
      python3 "$LIB/check_svg.py" --svg "$OUT" --expect-width "$w" --expect-height 1200 \
        > "$WORK/d3_$i.chk" 2>&1 || bad "index $i: $(LC_ALL=C tr '\n' '|' < "$WORK/d3_$i.chk" | head -c 400)"
    fi
    i=$((i + 1))
  done
endt

t "D4 &, <, >, \" and ' in labels are XML-escaped and round-trip"
  i=0
  while [ "$i" -lt 5 ]; do
    svg_run "d4_$i" --spec "$FIX/xml-specials.json" --index "$i"
    if [ "$RC" -ne 0 ]; then
      bad "index $i exited $RC: $(head -c 200 "$ERR")"
    else
      python3 "$LIB/check_svg.py" --svg "$OUT" > "$WORK/d4_$i.chk" 2>&1 \
        || bad "index $i: $(LC_ALL=C tr '\n' '|' < "$WORK/d4_$i.chk" | head -c 400)"
    fi
    i=$((i + 1))
  done
  svg_run d4h --spec "$FIX/xml-specials.json" --index 0
  if [ "$RC" -eq 0 ]; then
    python3 "$LIB/check_svg.py" --svg "$OUT" --require-text 'A&B' > "$WORK/d4h.chk" 2>&1 \
      || bad "hero title with & did not survive escaping: $(LC_ALL=C tr '\n' '|' < "$WORK/d4h.chk" | head -c 400)"
    grep -q '&amp;\|&#38;' "$OUT" || bad "no escaped ampersand found in the SVG source"
  fi
endt

t "D5 very long labels are wrapped/truncated, not dumped into one text run"
  i=0
  while [ "$i" -lt 3 ]; do
    svg_run "d5_$i" --spec "$FIX/long-labels.json" --index "$i"
    if [ "$RC" -ne 0 ]; then
      bad "index $i exited $RC: $(head -c 200 "$ERR")"
    else
      python3 "$LIB/check_svg.py" --svg "$OUT" --max-text-len 80 > "$WORK/d5_$i.chk" 2>&1 \
        || bad "index $i: $(LC_ALL=C tr '\n' '|' < "$WORK/d5_$i.chk" | head -c 500)"
    fi
    i=$((i + 1))
  done
endt

t "D6 --index beyond the end of figures is an error"
  svg_run d6 --spec "$FIX/basic5.json" --index 99
  expect_rc_nonzero "index out of range"; expect_no_traceback
  [ -s "$OUT" ] && bad "wrote SVG to stdout for an out-of-range index"
endt

t "D7 a negative --index is an error"
  svg_run d7 --spec "$FIX/basic5.json" --index -1
  expect_rc_nonzero "negative index"
  [ -s "$OUT" ] && bad "index -1 silently rendered the last figure (python negative indexing)"
endt

t "D8 a non-numeric --index is an error"
  svg_run d8 --spec "$FIX/basic5.json" --index abc
  expect_rc_nonzero "non-numeric index"; expect_no_traceback
endt

t "D9 --spec is required"
  svg_run d9 --index 0
  expect_rc_nonzero "missing --spec"
endt

t "D10 successful output starts an SVG document on stdout"
  svg_run d10 --spec "$FIX/basic5.json" --index 0
  if [ "$RC" -eq 0 ]; then
    head -c 200 "$OUT" | grep -q '<svg\|<?xml' || bad "stdout does not start an SVG document"
  fi
endt

t "D11 at least two palettes exist and produce different output"
  pals=""
  for probe in --palettes --list-palettes; do
    if run_timed 30 python3 "$SVG_FIGURES" "$probe" > "$WORK/d11.list" 2>/dev/null; then
      pals="$(grep -oE '^[a-z]{3,}-[a-z]{3,}$' "$WORK/d11.list" | sort -u | LC_ALL=C tr '\n' ' ')"
      [ -n "$pals" ] && break
    fi
  done
  if [ -z "$pals" ]; then
    run_timed 30 python3 "$SVG_FIGURES" --help > "$WORK/d11.help" 2>&1
    pals="$(grep -i 'palette' "$WORK/d11.help" \
            | grep -oE '\b[a-z]{3,}-[a-z]{3,}\b' | sort -u | LC_ALL=C tr '\n' ' ')"
  fi
  other=""
  for p in $pals; do
    case "$p" in
      amber-slate|svg-figures|make-images|max-bytes|target-bytes|self-contained) continue ;;
    esac
    other="$p"; break
  done
  if [ -z "$other" ]; then
    warn "the available palettes are not discoverable from the CLI, so '最低 2 種類' cannot be verified"
  else
    svg_run d11a --spec "$FIX/basic5.json" --index 0 --palette amber-slate
    expect_rc0
    cp "$OUT" "$WORK/d11a.keep" 2>/dev/null
    for p in $pals; do
      [ "$p" = "amber-slate" ] && continue
      svg_run "d11-$p" --spec "$FIX/basic5.json" --index 0 --palette "$p"
      if [ "$RC" -ne 0 ]; then
        bad "advertised palette '$p' fails to render: $(head -c 200 "$ERR")"
      elif cmp -s "$WORK/d11a.keep" "$OUT"; then
        bad "palette '$p' produces byte-identical output to amber-slate"
      fi
    done
  fi
endt
fi

# ========================================================== E: rasterize.sh ===
if want E; then
group "E. rasterize.sh"

ras_run() { # <tag> [args...]
  OUT="$WORK/$1.rout"; ERR="$WORK/$1.rerr"; shift
  run_timed 120 /bin/bash "$RASTERIZE" "$@" >"$OUT" 2>"$ERR"
  RC=$?
}

python3 "$SVG_FIGURES" --spec "$FIX/basic5.json" --index 0 > "$WORK/e.svg" 2>/dev/null
HAVE_E_SVG=0
[ -s "$WORK/e.svg" ] && HAVE_E_SVG=1
if [ "$HAVE_E_SVG" -eq 0 ]; then
  printf '%s\n' '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 1200"><rect width="1200" height="1200" fill="#f5efe0"/><text x="100" y="600" font-size="90" font-family="Hiragino Sans,sans-serif" fill="#333">テスト図版 &amp; more</text></svg>' > "$WORK/e.svg"
fi

t "E1 running with no arguments is an error naming --in"
  ras_run e1
  expect_rc_nonzero "no args"
  expect_stderr_nonempty
  grep -q -- '--in' "$ERR" || bad "the error does not say --in is required: $(errsnip)"
endt

t "E2 a valid SVG rasterizes to a real image at the requested long side"
  ras_run e2 --in "$WORK/e.svg" --out "$WORK/e2.jpg" --px 2048 --quality 88
  expect_rc0
  if [ "$RC" -eq 0 ]; then
    [ -s "$WORK/e2.jpg" ] || bad "output file is missing or empty"
    if [ -s "$WORK/e2.jpg" ]; then
      magic="$(od -An -tx1 -N3 "$WORK/e2.jpg" | tr -d ' \n')"
      case "$magic" in
        ffd8ff) : ;;
        89504e) bad "produced PNG content in a .jpg file" ;;
        *) bad "output is not a JPEG or PNG (magic=$magic)" ;;
      esac
      sz="$(wc -c < "$WORK/e2.jpg" | tr -d ' ')"
      [ "$sz" -lt 5000 ] && bad "output is only $sz bytes; the figure is probably blank"
      if [ "$HAVE_MAGICK" -eq 1 ]; then
        dims="$(magick identify -format '%w %h' "$WORK/e2.jpg" 2>/dev/null)"
        w="${dims% *}"; h="${dims#* }"
        if [ -n "$w" ] && [ -n "$h" ]; then
          long="$w"; [ "$h" -gt "$w" ] && long="$h"
          [ "$long" -ne 2048 ] && bad "long side is $long px, --px 2048 was requested (${w}x${h})"
        fi
      fi
    fi
  fi
endt

t "E3 --quality 999 is rejected (spec: 1-100)"
  ras_run e3 --in "$WORK/e.svg" --out "$WORK/e3.jpg" --px 1024 --quality 999
  expect_rc_nonzero "quality out of range"
endt

t "E4 --quality 0 is rejected"
  ras_run e4 --in "$WORK/e.svg" --out "$WORK/e4.jpg" --px 1024 --quality 0
  expect_rc_nonzero "quality 0"
endt

t "E5 a non-numeric --quality is rejected with a message about --quality"
  ras_run e5 --in "$WORK/e.svg" --out "$WORK/e5.jpg" --px 1024 --quality high
  expect_rc_nonzero "non-numeric quality"
  grep -qi 'quality' "$ERR" \
    || bad "failed without saying --quality was the problem (a bare shell arithmetic error is not a usable message): $(errsnip)"
endt

t "E6 a non-numeric --px is rejected with a message about --px"
  ras_run e6 --in "$WORK/e.svg" --out "$WORK/e6.jpg" --px huge --quality 88
  expect_rc_nonzero "non-numeric px"
  grep -qi 'px' "$ERR" \
    || bad "failed without saying --px was the problem: $(errsnip)"
endt

t "E7 a missing input file is an error, and no output is left behind"
  ras_run e7 --in "$WORK/nope.svg" --out "$WORK/e7.jpg" --px 1024 --quality 88
  expect_rc_nonzero "missing input"
  expect_stderr_nonempty
  grep -q 'nope.svg' "$ERR" \
    || bad "the error does not name the input file that was missing: $(errsnip)"
  [ -e "$WORK/e7.jpg" ] && bad "an output file was created for a failed rasterization"
endt

t "E8 output paths containing spaces and Japanese work"
  mkdir -p "$WORK/出力 dir"
  ras_run e8 --in "$WORK/e.svg" --out "$WORK/出力 dir/図 01.jpg" --px 1024 --quality 88
  expect_rc0
  [ "$RC" -eq 0 ] && [ ! -s "$WORK/出力 dir/図 01.jpg" ] && bad "no output at the spaced/Japanese path"
endt

t "E9 a bogus \$CHROME_BIN falls through to the other rasterizers"
  OUT="$WORK/e9.rout"; ERR="$WORK/e9.rerr"
  (
    CHROME_BIN="$WORK/no-such-chrome"; export CHROME_BIN
    run_timed 120 /bin/bash "$RASTERIZE" --in "$WORK/e.svg" --out "$WORK/e9.jpg" \
      --px 1024 --quality 88
  ) >"$OUT" 2>"$ERR"
  RC=$?
  if [ "$RC" -ne 0 ]; then
    bad "exit=$RC when CHROME_BIN points at a nonexistent file, although other rasterizers are available | $(errsnip)"
  else
    [ -s "$WORK/e9.jpg" ] || bad "exit 0 but no output file"
  fi
endt

t "E10 malformed SVG input fails loudly instead of producing a blank image"
  printf '%s' '<svg xmlns="http://www.w3.org/2000/svg"><text>unclosed' > "$WORK/e10.svg"
  ras_run e10 --in "$WORK/e10.svg" --out "$WORK/e10.jpg" --px 1024 --quality 88
  if [ "$RC" -eq 0 ]; then
    if [ ! -s "$WORK/e10.jpg" ]; then
      bad "exit 0 but the output file is empty"
    else
      warn "malformed SVG silently produced an image; callers cannot tell the figure is broken"
    fi
  fi
endt

t "E13 a Chrome that writes the PNG but never exits does not hang the pipeline"
  mkdir -p "$WORK/hangbin"
  cat > "$WORK/hangbin/chrome-writes-then-hangs" <<'SHIM'
#!/bin/bash
# Reproduces the observed headless Chrome behaviour: the screenshot is written,
# then the process never exits.
for a in "$@"; do
  case "$a" in --screenshot=*) shot="${a#--screenshot=}" ;; esac
done
[ -n "${shot:-}" ] && cp "$RSH_SAMPLE_PNG" "$shot"
sleep 600
SHIM
  chmod +x "$WORK/hangbin/chrome-writes-then-hangs"
  magick -size 1024x1024 gradient:white-navy "$WORK/sample.png" >/dev/null 2>&1
  if [ ! -s "$WORK/sample.png" ]; then
    skip "could not build a sample PNG for the shim"
  else
    OUT="$WORK/e13.out"; ERR="$WORK/e13.err"
    st=$(date +%s)
    (
      CHROME_BIN="$WORK/hangbin/chrome-writes-then-hangs"
      RSH_SAMPLE_PNG="$WORK/sample.png"
      export CHROME_BIN RSH_SAMPLE_PNG
      run_timed 300 /bin/bash "$RASTERIZE" --in "$WORK/e.svg" --out "$WORK/e13.jpg" \
        --px 1024 --quality 88
    ) >"$OUT" 2>"$ERR"
    RC=$?
    el=$(( $(date +%s) - st ))
    pgrep -f chrome-writes-then-hangs 2>/dev/null | while read -r hp; do kill -9 "$hp" 2>/dev/null; done
    if [ "$RC" -ge 124 ] || [ "$el" -ge 300 ]; then
      bad "rasterize.sh never returned on its own (exit=$RC after ${el}s; it had to be force-killed) when Chrome wrote the screenshot but did not exit. There is no timeout around the Chrome call, and the screenshot it had already written is discarded"
    else
      [ "$el" -gt 200 ] && warn "took ${el}s to recover from a hung Chrome"
    fi
  fi
[ -n "$CUR" ] && endt

t "E14 a Chrome that hangs without producing anything falls through to another renderer"
  cat > "$WORK/hangbin/chrome-just-hangs" <<'SHIM'
#!/bin/bash
sleep 600
SHIM
  chmod +x "$WORK/hangbin/chrome-just-hangs"
  OUT="$WORK/e14.out"; ERR="$WORK/e14.err"
  st=$(date +%s)
  (
    CHROME_BIN="$WORK/hangbin/chrome-just-hangs"; export CHROME_BIN
    run_timed 300 /bin/bash "$RASTERIZE" --in "$WORK/e.svg" --out "$WORK/e14.jpg" \
      --px 1024 --quality 88
  ) >"$OUT" 2>"$ERR"
  RC=$?
  el=$(( $(date +%s) - st ))
  pgrep -f chrome-just-hangs 2>/dev/null | while read -r hp; do kill -9 "$hp" 2>/dev/null; done
  if [ "$RC" -ge 124 ]; then
    bad "rasterize.sh never returned on its own (exit=$RC; it had to be force-killed) when Chrome hung. rsvg-convert / magick are never reached, so the documented fallback chain cannot run"
  elif [ "$RC" -ne 0 ]; then
    # magick's built-in SVG renderer cannot resolve fonts for <text>, which is
    # why the spec ranks it last; a clean, explanatory exit 1 is acceptable here.
    grep -q 'rsvg\|magick\|ImageMagick' "$ERR" \
      || bad "exit=$RC after a hung Chrome without saying which renderers were tried: $(errsnip)"
  fi
endt

# corner_case <tag> <viewBox w> <viewBox h> <--px> : the four corners of the
# rendered image must still carry their marker colours.
corner_case() {
  ctag="$1"; cvw="$2"; cvh="$3"; cpx="$4"
  csvg="$WORK/corner-$ctag.svg"
  mw=$(( cvw / 5 )); mh=$(( cvh / 5 ))
  {
    printf '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 %d %d">' "$cvw" "$cvh"
    printf '<rect width="%d" height="%d" fill="#ffffff"/>' "$cvw" "$cvh"
    printf '<rect x="0" y="0" width="%d" height="%d" fill="#ff0000"/>' "$mw" "$mh"
    printf '<rect x="%d" y="0" width="%d" height="%d" fill="#00ff00"/>' "$(( cvw - mw ))" "$mw" "$mh"
    printf '<rect x="0" y="%d" width="%d" height="%d" fill="#0000ff"/>' "$(( cvh - mh ))" "$mw" "$mh"
    printf '<rect x="%d" y="%d" width="%d" height="%d" fill="#ffff00"/>' "$(( cvw - mw ))" "$(( cvh - mh ))" "$mw" "$mh"
    printf '</svg>'
  } > "$csvg"
  ras_run "corner-$ctag" --in "$csvg" --out "$WORK/corner-$ctag.jpg" --px "$cpx" --quality 95
  if [ "$RC" -ne 0 ]; then
    bad "${cvw}x${cvh} at --px $cpx exited $RC: $(errsnip)"
    return
  fi
  dims="$(magick identify -format '%w %h' "$WORK/corner-$ctag.jpg" 2>/dev/null)"
  iw="${dims% *}"; ih="${dims#* }"
  if [ -z "$iw" ] || [ -z "$ih" ]; then
    bad "${cvw}x${cvh} at --px $cpx produced an unreadable image"
    return
  fi
  ix=$(( iw / 25 )); iy=$(( ih / 25 ))
  [ "$ix" -lt 1 ] && ix=1
  [ "$iy" -lt 1 ] && iy=1
  for spot in "TL:$ix:$iy:red" "TR:$(( iw - ix - 1 )):$iy:green" \
              "BL:$ix:$(( ih - iy - 1 )):blue" "BR:$(( iw - ix - 1 )):$(( ih - iy - 1 )):yellow"; do
    nm="${spot%%:*}"; rest="${spot#*:}"
    px="${rest%%:*}"; rest="${rest#*:}"
    py="${rest%%:*}"; want="${rest#*:}"
    rgb="$(magick "$WORK/corner-$ctag.jpg" -format "%[pixel:p{$px,$py}]" info: 2>/dev/null)"
    r="$(printf '%s' "$rgb" | sed -E 's/.*\(([0-9]+),.*/\1/')"
    g="$(printf '%s' "$rgb" | sed -E 's/.*,([0-9]+),([0-9]+).*/\1/')"
    b="$(printf '%s' "$rgb" | sed -E 's/.*,([0-9]+)[,)].*/\1/')"
    case "$r$g$b" in ''|*[!0-9]*) warn "could not sample $nm of $ctag ($rgb)"; continue ;; esac
    okc=0
    case "$want" in
      red)    [ "$r" -gt 150 ] && [ "$g" -lt 120 ] && [ "$b" -lt 120 ] && okc=1 ;;
      green)  [ "$g" -gt 150 ] && [ "$r" -lt 120 ] && [ "$b" -lt 120 ] && okc=1 ;;
      blue)   [ "$b" -gt 150 ] && [ "$r" -lt 120 ] && [ "$g" -lt 120 ] && okc=1 ;;
      yellow) [ "$r" -gt 150 ] && [ "$g" -gt 150 ] && [ "$b" -lt 120 ] && okc=1 ;;
    esac
    [ "$okc" -eq 0 ] && bad "viewBox ${cvw}x${cvh} at --px $cpx: the $nm corner is $rgb, expected $want. The image is the right size but the content is clipped"
  done
}

t "E15 content is not clipped at small --px or at extreme aspect ratios"
  if [ "$HAVE_MAGICK" -eq 0 ]; then
    skip "needs magick to sample pixels"
  else
    corner_case sq2048 1200 1200 2048
    corner_case sq300  1200 1200 300
    corner_case sq64   1200 1200 64
    corner_case wide   2400  600 1000
    corner_case tall    600 2400 1000
  fi
[ -n "$CUR" ] && endt

t "E12 a degenerate --px (0) is rejected rather than producing a 1px image"
  ras_run e12 --in "$WORK/e.svg" --out "$WORK/e12.jpg" --px 0 --quality 88
  if [ "$RC" -eq 0 ]; then
    if [ "$HAVE_MAGICK" -eq 1 ] && [ -s "$WORK/e12.jpg" ]; then
      dims="$(magick identify -format '%w %h' "$WORK/e12.jpg" 2>/dev/null)"
      bad "exit 0 with --px 0; produced a ${dims:-?} image instead of rejecting the value"
    else
      bad "exit 0 with --px 0"
    fi
  fi
endt

t "E11 --px and --quality are actually honoured (higher quality => more bytes)"
  ras_run e11a --in "$WORK/e.svg" --out "$WORK/e11a.jpg" --px 2048 --quality 60
  ras_run e11b --in "$WORK/e.svg" --out "$WORK/e11b.jpg" --px 2048 --quality 98
  if [ -s "$WORK/e11a.jpg" ] && [ -s "$WORK/e11b.jpg" ]; then
    a="$(wc -c < "$WORK/e11a.jpg" | tr -d ' ')"
    b="$(wc -c < "$WORK/e11b.jpg" | tr -d ' ')"
    [ "$b" -le "$a" ] && bad "quality 98 ($b bytes) is not larger than quality 60 ($a bytes); --quality is ignored"
  else
    bad "one of the two rasterizations produced no file"
  fi
endt
fi

# ================================================== F: end-to-end, svg engine =
if want F; then
group "F. end-to-end (svg engine)"

t "F1 basic 5-figure spec produces images, a manifest and the TOTAL_BYTES line"
  run_mi f1 "$PATH_NOCODEX" --spec "$FIX/basic5.json" --outdir "$WORK/f1out"
  expect_rc0
  if [ "$RC" -eq 0 ]; then
    expect_total_line svg
    n=$(ls "$WORK/f1out" 2>/dev/null | grep -cE '^fig-[0-9]+\.(jpg|png)$')
    [ "$n" -ne 5 ] && bad "expected 5 figure files, found $n"
    check_manifest "$WORK/f1out" "$FIX/basic5.json" --expect-engine svg \
      --expect-total "$TOTAL_BYTES" $REQ_JPEG
    check_no_temp_leak
    if [ "$HAVE_MAGICK" -eq 1 ]; then
      for f in "$WORK/f1out"/fig-*; do
        [ -f "$f" ] || continue
        sd="$(magick identify -format '%[standard-deviation]' "$f" 2>/dev/null)"
        sd="${sd%%.*}"
        case "$sd" in
          ''|*[!0-9-]*) warn "could not measure $(basename "$f")" ;;
          *) [ "$sd" -lt 300 ] && bad "$(basename "$f") is nearly uniform (stddev=$sd); the figure is probably blank" ;;
        esac
      done
    fi
  fi
endt

t "F2 the outdir is created when it does not exist (including parents)"
  run_mi f2 "$PATH_NOCODEX" --spec "$FIX/one-hero.json" --outdir "$WORK/f2/deep/nested/out"
  expect_rc0
  [ "$RC" -eq 0 ] && [ ! -f "$WORK/f2/deep/nested/out/manifest.json" ] \
    && bad "nested outdir was not created"
endt

t "F3 alt text with &, <, >, \" and ' round-trips into manifest.json byte-exactly"
  run_mi f3 "$PATH_NOCODEX" --spec "$FIX/xml-specials.json" --outdir "$WORK/f3out"
  expect_rc0
  if [ "$RC" -eq 0 ]; then
    expect_total_line svg
    check_manifest "$WORK/f3out" "$FIX/xml-specials.json" --expect-engine svg \
      --expect-total "$TOTAL_BYTES" $REQ_JPEG
  fi
endt

t "F4 default run reaches --target-bytes or says why it could not"
  run_mi f4 "$PATH_NOCODEX" --spec "$FIX/basic5.json" --outdir "$WORK/f4out"
  expect_rc0
  if [ "$RC" -eq 0 ]; then
    expect_total_line svg
    if [ "$TOTAL_BYTES" -lt 860000 ]; then
      grep -qiE 'warn|警告|不足|target' "$ERR" "$OUT" \
        || bad "TOTAL_BYTES=$TOTAL_BYTES is below the default target 860000 and no warning was printed"
    fi
  fi
endt

t "F6 each figure is a distinct image, not the same one written N times"
  if [ -d "$WORK/f1out" ]; then
    ls "$WORK/f1out"/fig-* >/dev/null 2>&1 || bad "F1 left no images to compare"
    dupes="$(md5 -q "$WORK/f1out"/fig-* 2>/dev/null | sort | uniq -d)"
    [ -z "$dupes" ] || bad "several figures are byte-identical images (md5 $dupes)"
    sizes="$(for f in "$WORK/f1out"/fig-*; do wc -c < "$f"; done | tr -d ' ' | sort -u | wc -l)"
    [ "$(printf '%s' "$sizes" | tr -d ' ')" = "1" ] \
      && warn "all five figures have the same byte size; check they really differ"
  else
    skip "F1 produced no output"
  fi
[ -n "$CUR" ] && endt

t "F7 leftovers named fig-100 and up are also cleaned from the outdir"
  mkdir -p "$WORK/f7out"
  head -c 40000 /dev/urandom > "$WORK/f7out/fig-100.jpg"
  head -c 40000 /dev/urandom > "$WORK/f7out/fig-07.jpg"
  run_mi f7 "$PATH_NOCODEX" --spec "$FIX/two.json" --outdir "$WORK/f7out" --target-bytes 1
  expect_rc0
  if [ "$RC" -eq 0 ]; then
    [ -f "$WORK/f7out/fig-07.jpg" ] && bad "two-digit leftover fig-07.jpg was not cleaned"
    if [ -f "$WORK/f7out/fig-100.jpg" ]; then
      warn "fig-100.jpg survives: the cleanup loop stops at fig-99, but specs with 100+ figures pass validation, so a shrinking run can leave stale three-digit images"
    fi
  fi
endt

t "F5 stale images from a previous, longer run are not left in the outdir"
  run_mi f5a "$PATH_NOCODEX" --spec "$FIX/basic5.json" --outdir "$WORK/f5out"
  run_mi f5b "$PATH_NOCODEX" --spec "$FIX/two.json" --outdir "$WORK/f5out"
  expect_rc0
  if [ "$RC" -eq 0 ]; then
    if ls "$WORK/f5out"/fig-03.* >/dev/null 2>&1; then
      bad "fig-03..05 from the earlier 5-figure run survive into a 2-figure run; a caller globbing the outdir would embed stale images"
    fi
    # must re-read the second run's total; $TOTAL_BYTES still holds the previous test's value
    expect_total_line svg
    check_manifest "$WORK/f5out" "$FIX/two.json" --expect-total "$TOTAL_BYTES"
  fi
endt
fi

# ==================================================== G: engine selection =====
if want G; then
group "G. engine selection"

t "G1 --engine codex with no codex on PATH fails instead of falling back to svg"
  run_mi g1 "$PATH_NOCODEX" --spec "$FIX/one-hero.json" --outdir "$WORK/g1out" --engine codex
  expect_rc_nonzero "explicit codex, codex unavailable"
  expect_stderr_nonempty
  expect_no_total
  grep -qi 'codex' "$ERR" "$OUT" 2>/dev/null || bad "the error message does not mention codex"
  if [ -d "$WORK/g1out" ]; then
    ls "$WORK/g1out"/fig-*.jpg >/dev/null 2>&1 && bad "svg images were produced despite --engine codex"
  fi
endt

t "G2 --engine codex with a failing 'codex login status' fails"
  CODEX_LOG="$WORK/g2.log"; export CODEX_LOG; : > "$CODEX_LOG"
  run_mi g2 "$PATH_CODEXFAIL" --spec "$FIX/one-hero.json" --outdir "$WORK/g2out" --engine codex
  unset CODEX_LOG
  expect_rc_nonzero "explicit codex, not logged in"
  expect_no_total
  grep -q 'login status' "$WORK/g2.log" 2>/dev/null \
    || bad "'codex login status' was never run (spec: login status が成功するか確認)"
endt

t "G3 --engine auto with no codex falls back to svg"
  run_mi g3 "$PATH_NOCODEX" --spec "$FIX/one-hero.json" --outdir "$WORK/g3out" --engine auto
  expect_rc0
  [ "$RC" -eq 0 ] && expect_total_line svg
endt

t "G4 --engine auto with a codex that is not logged in falls back to svg"
  CODEX_LOG="$WORK/g4.log"; export CODEX_LOG; : > "$CODEX_LOG"
  run_mi g4 "$PATH_CODEXFAIL" --spec "$FIX/one-hero.json" --outdir "$WORK/g4out" --engine auto
  unset CODEX_LOG
  expect_rc0
  [ "$RC" -eq 0 ] && expect_total_line svg
  grep -q 'login status' "$WORK/g4.log" 2>/dev/null \
    || warn "auto mode never probed 'codex login status'"
endt

t "G5 --engine svg wins even when codex is available and logged in"
  CODEX_LOG="$WORK/g5.log"; export CODEX_LOG; : > "$CODEX_LOG"
  run_mi g5 "$PATH_CODEXOK" --spec "$FIX/one-hero.json" --outdir "$WORK/g5out" --engine svg
  unset CODEX_LOG
  expect_rc0
  [ "$RC" -eq 0 ] && expect_total_line svg
  if grep -v 'login status' "$WORK/g5.log" 2>/dev/null | grep -q 'codex-shim called'; then
    bad "codex was invoked despite --engine svg: $(grep -v 'login status' "$WORK/g5.log" | head -c 200)"
  fi
endt

t "G7 --engine auto with a usable codex does not quietly render with svg"
  CODEX_LOG="$WORK/g7.log"; export CODEX_LOG; : > "$CODEX_LOG"
  run_mi g7 "$PATH_CODEXOK" --spec "$FIX/one-hero.json" --outdir "$WORK/g7out" --engine auto
  unset CODEX_LOG
  # The stub codex authenticates but cannot generate, so the run is expected to
  # fail. What must not happen is a silent downgrade to the svg engine.
  if grep -q 'ENGINE=svg' "$OUT"; then
    bad "auto chose svg even though 'codex login status' succeeded; the user asked for the best available engine and got the fallback without being told"
  fi
  if [ "$RC" -eq 0 ]; then
    expect_total_line codex
  else
    grep -qi 'codex' "$ERR" || bad "failed without explaining that the codex engine was the problem: $(errsnip)"
  fi
  grep -q 'login status' "$WORK/g7.log" 2>/dev/null \
    || bad "'codex login status' was never run, so codex cannot have been selected on evidence"
endt

t "G6 the default engine is auto, so no codex means ENGINE=svg"
  run_mi g6 "$PATH_NOCODEX" --spec "$FIX/one-hero.json" --outdir "$WORK/g6out"
  expect_rc0
  [ "$RC" -eq 0 ] && expect_total_line svg
endt
fi

# ======================================================== H: byte budget =====
if want H; then
group "H. byte budget loop"

B1=0
t "H1 baseline: a trivially small target stops at tier 1"
  run_mi h1 "$PATH_NOCODEX" --spec "$FIX/one-hero.json" --outdir "$WORK/h1out" --target-bytes 1
  expect_rc0
  if [ "$RC" -eq 0 ]; then
    expect_total_line svg
    B1="$TOTAL_BYTES"
    [ "$B1" -le 0 ] && bad "TOTAL_BYTES=$B1"
    if [ "$HAVE_MAGICK" -eq 1 ] && [ -f "$WORK/h1out/fig-01.jpg" ]; then
      dims="$(magick identify -format '%w %h' "$WORK/h1out/fig-01.jpg" 2>/dev/null)"
      w="${dims% *}"; h="${dims#* }"
      if [ -n "$w" ] && [ -n "$h" ]; then
        long="$w"; [ "$h" -gt "$w" ] && long="$h"
        [ "$long" -ne 2048 ] && bad "tier 1 should render at 2048px long side, got ${w}x${h}"
      fi
    fi
  fi
endt

t "H2 an unreachable target warns and still exits 0 (spec: 異常終了はしない)"
  run_mi h2 "$PATH_NOCODEX" --spec "$FIX/one-hero.json" --outdir "$WORK/h2out" \
    --target-bytes 999999999
  if [ "$RC" -ne 0 ]; then
    bad "exit=$RC; the spec requires a warning and a normal exit when the target is unreachable | $(errsnip)"
  else
    expect_total_line svg
    if ! grep -iE 'warn|警告' "$ERR" "$OUT" | grep -q "$TOTAL_BYTES"; then
      bad "no warning names the achieved total ($TOTAL_BYTES bytes) even though the target was never reached; the caller cannot tell it must add figures: $(errsnip)"
    fi
    [ -s "$ERR" ] || warn "the warning is not on stderr"
    if [ "$B1" -gt 0 ] && [ "$TOTAL_BYTES" -le "$B1" ]; then
      bad "quality was never escalated: TOTAL_BYTES=$TOTAL_BYTES is not above the tier-1 baseline $B1"
    fi
    [ "$TOTAL_BYTES" -gt 3000000 ] && bad "TOTAL_BYTES=$TOTAL_BYTES exceeds the default --max-bytes 3000000"
    if [ "$HAVE_MAGICK" -eq 1 ] && [ -f "$WORK/h2out/fig-01.jpg" ]; then
      dims="$(magick identify -format '%w %h' "$WORK/h2out/fig-01.jpg" 2>/dev/null)"
      w="${dims% *}"; h="${dims#* }"
      long="$w"; [ -n "$h" ] && [ "$h" -gt "$w" ] && long="$h"
      [ -n "$long" ] && [ "$long" -lt 2048 ] && bad "final long side is ${long}px, below the tier-1 2048px"
    fi
    check_manifest "$WORK/h2out" "$FIX/one-hero.json" --expect-total "$TOTAL_BYTES" $REQ_JPEG
  fi
endt

t "H3 --max-bytes stops the escalation (spec: --max-bytes を超える段には進まない)"
  if [ "$B1" -le 0 ]; then
    skip "no tier-1 baseline from H1"
  else
    run_mi h3 "$PATH_NOCODEX" --spec "$FIX/one-hero.json" --outdir "$WORK/h3out" \
      --target-bytes 999999999 --max-bytes "$B1"
    if [ "$RC" -ne 0 ]; then
      bad "exit=$RC; an unreachable target must warn and exit 0 | $(errsnip)"
    else
      expect_total_line svg
      [ "$TOTAL_BYTES" -gt "$B1" ] \
        && bad "TOTAL_BYTES=$TOTAL_BYTES exceeds --max-bytes=$B1; a tier over the cap was accepted"
      check_manifest "$WORK/h3out" "$FIX/one-hero.json" --expect-total "$TOTAL_BYTES"
    fi
    endt
  fi
[ -n "$CUR" ] && endt

t "H4 an impossibly small --max-bytes still terminates cleanly"
  run_mi h4 "$PATH_NOCODEX" --spec "$FIX/one-hero.json" --outdir "$WORK/h4out" \
    --target-bytes 999999999 --max-bytes 1000
  [ "$RC" -ge 124 ] && bad "exit=$RC (hang/crash)"
  if [ "$RC" -gt 1 ] && [ "$RC" -lt 124 ]; then
    warn "exit=$RC for an unsatisfiable --max-bytes; 0 (warn) or 1 (clear error) expected"
  fi
  [ "$RC" -eq 0 ] && expect_total_line svg
endt

t "H5 the reported TOTAL_BYTES equals the bytes actually on disk"
  if [ -d "$WORK/h2out" ]; then
    sum=0
    for f in "$WORK/h2out"/fig-*; do
      [ -f "$f" ] || continue
      sz="$(wc -c < "$f" | tr -d ' ')"
      sum=$((sum + sz))
    done
    run_mi h5 "$PATH_NOCODEX" --spec "$FIX/two.json" --outdir "$WORK/h5out"
    if [ "$RC" -eq 0 ]; then
      expect_total_line svg
      sum2=0
      for f in "$WORK/h5out"/fig-*; do
        [ -f "$f" ] || continue
        sz="$(wc -c < "$f" | tr -d ' ')"
        sum2=$((sum2 + sz))
      done
      [ "$sum2" -ne "$TOTAL_BYTES" ] \
        && bad "TOTAL_BYTES=$TOTAL_BYTES but the files on disk add up to $sum2"
    else
      bad "exit=$RC | $(errsnip)"
    fi
  else
    skip "H2 produced no output"
  fi
endt
fi

# ========================================================= I: robustness =====
if want I; then
group "I. robustness"

t "I1 the same spec produces the same total on a second run"
  run_mi i1a "$PATH_NOCODEX" --spec "$FIX/two.json" --outdir "$WORK/i1a"
  ta=0; [ "$RC" -eq 0 ] && { expect_total_line svg; ta="$TOTAL_BYTES"; } || bad "first run exit=$RC"
  run_mi i1b "$PATH_NOCODEX" --spec "$FIX/two.json" --outdir "$WORK/i1b"
  tb=0; [ "$RC" -eq 0 ] && { expect_total_line svg; tb="$TOTAL_BYTES"; } || bad "second run exit=$RC"
  if [ "$ta" -gt 0 ] && [ "$tb" -gt 0 ] && [ "$ta" -ne "$tb" ]; then
    bad "TOTAL_BYTES differs between identical runs: $ta vs $tb"
  fi
endt

t "I2 an outdir containing spaces and Japanese works"
  run_mi i2 "$PATH_NOCODEX" --spec "$FIX/two.json" --outdir "$WORK/出力 フォルダ/画像 out"
  expect_rc0
  if [ "$RC" -eq 0 ]; then
    expect_total_line svg
    [ -f "$WORK/出力 フォルダ/画像 out/manifest.json" ] || bad "no manifest at the spaced/Japanese outdir"
    check_manifest "$WORK/出力 フォルダ/画像 out" "$FIX/two.json" --expect-total "$TOTAL_BYTES"
  fi
endt

t "I3 a spec path containing spaces works"
  mkdir -p "$WORK/spec dir"
  cp "$FIX/one-hero.json" "$WORK/spec dir/my spec.json"
  run_mi i3 "$PATH_NOCODEX" --spec "$WORK/spec dir/my spec.json" --outdir "$WORK/i3out"
  expect_rc0
endt

t "I4 an unwritable outdir fails cleanly instead of half-succeeding"
  mkdir -p "$WORK/ro"
  chmod 500 "$WORK/ro"
  run_mi i4 "$PATH_NOCODEX" --spec "$FIX/one-hero.json" --outdir "$WORK/ro/sub"
  chmod 700 "$WORK/ro"
  expect_rc_nonzero "unwritable outdir"
  expect_stderr_nonempty
  expect_no_total
endt

t "I5 no temporary files are left behind"
  run_mi i5 "$PATH_NOCODEX" --spec "$FIX/two.json" --outdir "$WORK/i5out"
  expect_rc0
  check_no_temp_leak
endt

t "I6 the current working directory is not polluted"
  mkdir -p "$WORK/cwd" "$WORK/tmp-i6"
  (
    cd "$WORK/cwd" || exit 99
    PATH="$PATH_NOCODEX"; TMPDIR="$WORK/tmp-i6"; export PATH TMPDIR
    run_timed "$MI_TIMEOUT" /bin/bash "$MAKE_IMAGES" \
      --spec "$FIX/one-hero.json" --outdir "$WORK/i6out"
  ) >"$WORK/i6.out" 2>"$WORK/i6.err"
  rc=$?
  [ "$rc" -ne 0 ] && bad "exit=$rc | $(head -c 300 "$WORK/i6.err" | LC_ALL=C tr '\n' ' ')"
  left="$(ls -A "$WORK/cwd" 2>/dev/null | LC_ALL=C tr '\n' ' ')"
  [ -n "$left" ] && bad "files were created in the working directory: $left"
endt

t "I7 relative --spec and --outdir paths work"
  mkdir -p "$WORK/rel"
  cp "$FIX/one-hero.json" "$WORK/rel/spec.json"
  mkdir -p "$WORK/tmp-i7"
  (
    cd "$WORK/rel" || exit 99
    PATH="$PATH_NOCODEX"; TMPDIR="$WORK/tmp-i7"; export PATH TMPDIR
    run_timed "$MI_TIMEOUT" /bin/bash "$MAKE_IMAGES" --spec spec.json --outdir out
  ) >"$WORK/i7.out" 2>"$WORK/i7.err"
  rc=$?
  if [ "$rc" -ne 0 ]; then
    bad "exit=$rc with relative paths | $(head -c 300 "$WORK/i7.err" | LC_ALL=C tr '\n' ' ')"
  else
    [ -f "$WORK/rel/out/manifest.json" ] || bad "no manifest at the relative outdir"
    tail -n 1 "$WORK/i7.out" | grep -Eq '^TOTAL_BYTES=[0-9]+ ENGINE=(svg|codex)$' \
      || bad "bad final line with relative paths: $(tail -n 1 "$WORK/i7.out" | head -c 160)"
  fi
endt

t "I8 two concurrent runs do not collide (mktemp -d, not a fixed temp name)"
  mkdir -p "$WORK/tmp-i8a" "$WORK/tmp-i8b"
  (
    PATH="$PATH_NOCODEX"; TMPDIR="$WORK/tmp-i8a"; export PATH TMPDIR
    run_timed "$MI_TIMEOUT" /bin/bash "$MAKE_IMAGES" --spec "$FIX/two.json" --outdir "$WORK/i8a"
  ) >"$WORK/i8a.out" 2>"$WORK/i8a.err" &
  p1=$!
  (
    PATH="$PATH_NOCODEX"; TMPDIR="$WORK/tmp-i8b"; export PATH TMPDIR
    run_timed "$MI_TIMEOUT" /bin/bash "$MAKE_IMAGES" --spec "$FIX/two.json" --outdir "$WORK/i8b"
  ) >"$WORK/i8b.out" 2>"$WORK/i8b.err" &
  p2=$!
  wait $p1; r1=$?
  wait $p2; r2=$?
  [ "$r1" -ne 0 ] && bad "concurrent run A exit=$r1 | $(head -c 250 "$WORK/i8a.err" | LC_ALL=C tr '\n' ' ')"
  [ "$r2" -ne 0 ] && bad "concurrent run B exit=$r2 | $(head -c 250 "$WORK/i8b.err" | LC_ALL=C tr '\n' ' ')"
  if [ "$r1" -eq 0 ] && [ "$r2" -eq 0 ]; then
    a="$(tail -n 1 "$WORK/i8a.out")"; b="$(tail -n 1 "$WORK/i8b.out")"
    [ "$a" != "$b" ] && warn "concurrent identical runs disagree: '$a' vs '$b'"
  fi
endt

t "I9 make-images.sh is runnable directly via its shebang"
  if [ -x "$MAKE_IMAGES" ]; then
    OUT="$WORK/i9.out"; ERR="$WORK/i9.err"
    ( PATH="$PATH_NOCODEX"; export PATH; run_timed 60 "$MAKE_IMAGES" --help ) >"$OUT" 2>"$ERR"
    RC=$?
    expect_rc0
  else
    bad "make-images.sh is not executable"
  fi
endt
fi

# ------------------------------------------------------------------ summary --
printf '\n================ summary ================\n'
printf 'PASS=%s FAIL=%s WARN=%s SKIP=%s\n' "$PASS" "$FAIL" "$WARN" "$SKIP"
if [ -n "$FAIL_LIST" ]; then printf '\nfailed:%s\n' "$FAIL_LIST"; fi
if [ -n "$WARN_LIST" ]; then printf '\nwarnings (not fatal):%s\n' "$WARN_LIST"; fi
[ "$FAIL" -gt 0 ] && exit 1
exit 0
