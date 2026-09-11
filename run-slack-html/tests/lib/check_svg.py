#!/usr/bin/env python3
"""Validate one SVG produced by svg-figures.py against SPEC.md.

Spec points checked here:
  - well-formed XML (=> "文字列は XML エスケープすること")
  - viewBox 1200x1200 by default, 1800x1200 for compare
  - font-family carries a fallback chain ending in a generic family
  - required literal strings survive escaping/unescaping round-trip
  - no single text run is long enough to run off the canvas
Exit 0 when clean, 1 otherwise.
"""
import argparse
import re
import sys
import xml.etree.ElementTree as ET

SVG_NS = "http://www.w3.org/2000/svg"

errors = []


def err(msg):
    errors.append(msg)


def localname(tag):
    return tag.split("}")[-1] if "}" in tag else tag


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--svg", required=True)
    ap.add_argument("--expect-width", type=float)
    ap.add_argument("--expect-height", type=float)
    ap.add_argument("--require-text", action="append", default=[])
    ap.add_argument("--max-text-len", type=int, default=0)
    ap.add_argument("--require-font-fallback", action="store_true")
    args = ap.parse_args()

    with open(args.svg, "rb") as f:
        raw = f.read()
    if not raw.strip():
        print("ERROR: SVG output is empty")
        return 1

    try:
        root = ET.fromstring(raw)
    except ET.ParseError as exc:
        print("ERROR: SVG is not well-formed XML: %s" % exc)
        print("ERROR: first 400 bytes: %r" % raw[:400])
        return 1

    if localname(root.tag) != "svg":
        err("root element is <%s>, expected <svg>" % localname(root.tag))
    if root.tag.startswith("{") and not root.tag.startswith("{" + SVG_NS + "}"):
        err("root element is in namespace %r, expected the SVG namespace" % root.tag)
    elif not root.tag.startswith("{"):
        err("root <svg> has no xmlns; browsers will not render it as SVG")

    vb = root.get("viewBox")
    if not vb:
        err("<svg> has no viewBox attribute")
    else:
        parts = re.split(r"[\s,]+", vb.strip())
        if len(parts) != 4:
            err("viewBox %r does not have 4 numbers" % vb)
        else:
            try:
                _, _, w, h = (float(p) for p in parts)
            except ValueError:
                err("viewBox %r contains non-numeric values" % vb)
                w = h = None
            if w is not None:
                if args.expect_width and abs(w - args.expect_width) > 0.5:
                    err("viewBox width is %g, expected %g" % (w, args.expect_width))
                if args.expect_height and abs(h - args.expect_height) > 0.5:
                    err("viewBox height is %g, expected %g" % (h, args.expect_height))

    text_nodes = [e for e in root.iter() if localname(e.tag) in ("text", "tspan")]
    if not text_nodes:
        err("SVG contains no <text> elements at all")

    if args.require_font_fallback:
        fams = []
        for e in root.iter():
            ff = e.get("font-family")
            if ff:
                fams.append(ff)
        for e in root.iter():
            if localname(e.tag) == "style" and e.text:
                fams.extend(re.findall(r"font-family\s*:\s*([^;{}]+)", e.text))
        if not fams:
            err("no font-family is specified anywhere (Japanese text will not render)")
        else:
            ok = False
            for ff in fams:
                names = [n.strip().strip('"\'') for n in ff.split(",") if n.strip()]
                generic = names and names[-1].lower() in (
                    "sans-serif", "serif", "monospace", "system-ui")
                if len(names) >= 2 and generic:
                    ok = True
            if not ok:
                err("no font-family has a fallback chain ending in a generic family: %r"
                    % fams)

    alltext = "".join(t for t in root.itertext())
    for want in args.require_text:
        if want not in alltext:
            err("text %r does not appear in the rendered SVG text (got %r)"
                % (want, alltext[:400]))

    if args.max_text_len:
        for e in text_nodes:
            if localname(e.tag) != "text":
                continue
            joined = "".join(e.itertext())
            if len(joined) > args.max_text_len:
                err("a <text> run is %d characters long (>%d); long labels must be "
                    "wrapped or truncated so they do not overflow the figure: %r"
                    % (len(joined), args.max_text_len, joined[:120]))

    for e in errors:
        print("ERROR: " + e)
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
