#!/usr/bin/env python3
"""Validate manifest.json against the spec JSON and the files actually on disk.

Derived from SPEC.md:
  - "<outdir>/manifest.json -- 各図版の file / alt / bytes / engine と合計バイト"
  - "<outdir>/fig-01.jpg, fig-02.jpg, ... (spec の figures 順)"

The spec does NOT name the top-level keys of manifest.json, so this checker is
deliberately tolerant about the container key names and strict about the values.
Exit 0 when everything lines up, 1 otherwise; every problem is printed.
"""
import argparse
import json
import os
import re
import sys

JPEG_MAGIC = b"\xff\xd8\xff"
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"

errors = []
notes = []


def err(msg):
    errors.append(msg)


def load_json(path, what):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception as exc:  # noqa: BLE001
        err("%s could not be parsed as JSON: %s" % (what, exc))
        return None


def find_entries(manifest):
    """Return (entries, key) for the list of per-figure records."""
    if isinstance(manifest, list):
        return manifest, "<root>"
    if isinstance(manifest, dict):
        best = None
        for key, val in manifest.items():
            if isinstance(val, list) and val and all(isinstance(x, dict) for x in val):
                if all("file" in x for x in val):
                    return val, key
                if best is None:
                    best = (val, key)
        if best:
            return best
        for key, val in manifest.items():
            if isinstance(val, list):
                return val, key
    return None, None


def find_total(manifest):
    """Return (total, key) for the declared total byte count."""
    if not isinstance(manifest, dict):
        return None, None
    exact = ["total_bytes", "totalBytes", "total", "bytes_total", "bytes"]
    for key in exact:
        if isinstance(manifest.get(key), (int, float)):
            return int(manifest[key]), key
    for key, val in manifest.items():
        if isinstance(val, (int, float)) and not isinstance(val, bool):
            if "total" in key.lower() or "bytes" in key.lower():
                return int(val), key
    return None, None


def resolve(fileval, outdir):
    cands = []
    if os.path.isabs(fileval):
        cands.append(fileval)
    else:
        cands.append(os.path.join(outdir, fileval))
        cands.append(os.path.join(outdir, os.path.basename(fileval)))
    for c in cands:
        if os.path.isfile(c):
            return c
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--spec", required=True)
    ap.add_argument("--outdir", required=True)
    ap.add_argument("--expect-engine")
    ap.add_argument("--expect-total", type=int)
    ap.add_argument("--require-jpeg", action="store_true")
    args = ap.parse_args()

    if not os.path.isfile(args.manifest):
        print("ERROR: manifest.json does not exist at %s" % args.manifest)
        return 1

    manifest = load_json(args.manifest, "manifest.json")
    spec = load_json(args.spec, "spec JSON")
    if manifest is None or spec is None:
        for e in errors:
            print("ERROR: " + e)
        return 1

    figures = spec.get("figures") if isinstance(spec, dict) else None
    if not isinstance(figures, list):
        print("ERROR: test fixture problem - spec has no figures list")
        return 1

    entries, key = find_entries(manifest)
    if entries is None:
        err("manifest has no list of per-figure records (keys: %r)"
            % (list(manifest.keys()) if isinstance(manifest, dict) else type(manifest)))
        for e in errors:
            print("ERROR: " + e)
        return 1
    notes.append("entries found under key %r" % key)

    if len(entries) != len(figures):
        err("manifest lists %d figures but spec has %d" % (len(entries), len(figures)))

    seen_paths = []
    sum_declared = 0
    for i, entry in enumerate(entries):
        tag = "entry[%d]" % i
        if not isinstance(entry, dict):
            err("%s is not an object: %r" % (tag, entry))
            continue
        for field in ("file", "alt", "bytes", "engine"):
            if field not in entry:
                err("%s is missing required field %r (has %r)"
                    % (tag, field, sorted(entry.keys())))

        fileval = entry.get("file")
        path = None
        if isinstance(fileval, str) and fileval:
            path = resolve(fileval, args.outdir)
            if path is None:
                err("%s file %r does not exist under %s" % (tag, fileval, args.outdir))
            else:
                seen_paths.append(os.path.realpath(path))
                base = os.path.basename(path)
                if not re.match(r"^fig-\d{2,}\.(jpg|jpeg|png)$", base):
                    err("%s filename %r does not match fig-NN.<jpg|png>" % (tag, base))
                else:
                    num = int(re.findall(r"\d+", base)[0])
                    if num != i + 1:
                        err("%s filename %r is out of order (expected index %d)"
                            % (tag, base, i + 1))
        else:
            err("%s has no usable 'file' value: %r" % (tag, fileval))

        if path:
            actual = os.path.getsize(path)
            if actual == 0:
                err("%s file %s is 0 bytes" % (tag, path))
            elif actual < 1024:
                err("%s file %s is suspiciously small (%d bytes)" % (tag, path, actual))
            declared = entry.get("bytes")
            if isinstance(declared, bool) or not isinstance(declared, int):
                err("%s bytes is not an integer: %r" % (tag, declared))
            else:
                sum_declared += declared
                if declared != actual:
                    err("%s bytes=%d but the file is actually %d bytes"
                        % (tag, declared, actual))
            with open(path, "rb") as f:
                head = f.read(8)
            is_jpeg = head.startswith(JPEG_MAGIC)
            is_png = head.startswith(PNG_MAGIC)
            if not (is_jpeg or is_png):
                err("%s file %s is not a JPEG or PNG (magic bytes %r)"
                    % (tag, os.path.basename(path), head))
            else:
                ext = os.path.splitext(path)[1].lower()
                if is_jpeg and ext == ".png":
                    err("%s %s has .png extension but JPEG content" % (tag, os.path.basename(path)))
                if is_png and ext in (".jpg", ".jpeg"):
                    err("%s %s has %s extension but PNG content"
                        % (tag, os.path.basename(path), ext))
                if args.require_jpeg and not is_jpeg:
                    err("%s %s is PNG, but ImageMagick is available so JPEG was expected"
                        % (tag, os.path.basename(path)))

        if i < len(figures) and isinstance(figures[i], dict):
            want_alt = figures[i].get("alt")
            got_alt = entry.get("alt")
            if got_alt != want_alt:
                err("%s alt mismatch: manifest %r vs spec %r" % (tag, got_alt, want_alt))

        engine = entry.get("engine")
        if engine not in ("svg", "codex"):
            err("%s engine is %r, expected 'svg' or 'codex'" % (tag, engine))
        elif args.expect_engine and engine != args.expect_engine:
            err("%s engine is %r, expected %r" % (tag, engine, args.expect_engine))

    if len(set(seen_paths)) != len(seen_paths):
        err("manifest points several entries at the same file: %r" % seen_paths)

    total, tkey = find_total(manifest)
    if total is None:
        err("manifest has no numeric total byte count (spec: '合計バイト')")
    else:
        notes.append("total found under key %r" % tkey)
        if total != sum_declared:
            err("manifest total %s=%d does not equal the sum of entry bytes %d"
                % (tkey, total, sum_declared))
        if args.expect_total is not None and total != args.expect_total:
            err("manifest total %d does not equal stdout TOTAL_BYTES %d"
                % (total, args.expect_total))

    # Stale images left behind from an earlier run would silently be picked up
    # by a caller globbing the outdir.
    on_disk = sorted(
        f for f in os.listdir(args.outdir)
        if re.match(r"^fig-\d+\.(jpg|jpeg|png)$", f)
    )
    listed = sorted(os.path.basename(p) for p in seen_paths)
    extra = [f for f in on_disk if f not in listed]
    if extra:
        err("outdir contains image files not listed in the manifest (stale output?): %r"
            % extra)

    for n in notes:
        print("NOTE: " + n)
    for e in errors:
        print("ERROR: " + e)
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
