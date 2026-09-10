#!/usr/bin/env python3
"""
Find published expectations the hand pass may have missed.

Expected values and tolerances are curated by hand on purpose: a wrong
tolerance calls a good supply bad, which is worse than having no tolerance at
all. So this tool does not write anything. It reads the procedure prose that a
human already transcribed from, points at every number in it, and says whether
a curated expectation exists that could have come from that number.

What it is good at: showing that §5-20 step 3 states a voltage and nothing in
testpoints.json scores against it. What it cannot do: decide whether that
number was a limit, an instrument setting, or a value quoted in passing. That
judgement stays with the reader, which is the whole point.

    tools/audit_expectations.py a14
    tools/audit_expectations.py --all
    tools/audit_expectations.py a14 --verbose   # also list covered steps
"""

import argparse
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DATA = os.path.join(ROOT, "data")


def load(asm):
    """Read data/<asm>.js, which is a JSON object inside a script assignment."""
    path = os.path.join(DATA, "%s.js" % asm)
    if not os.path.exists(path):
        return None
    text = open(path, encoding="utf-8").read()
    start = text.index("{")
    return json.loads(text[start:text.rindex("}") + 1])


# ---------------------------------------------------------------- extraction

# Things that look like measurements but are not expectations. Scope and
# generator settings are the big one: "20V/div and 500 us/div" is three numbers
# and no limit at all.
NOISE = [
    re.compile(r"\b\d+(?:\.\d+)?\s*[a-zµ]*\s*/\s*div\b", re.I),   # 20V/div
    re.compile(r"\bfigure\s+\d+-\d+", re.I),
    re.compile(r"\btable\s+\d+-\d+", re.I),
    re.compile(r"\bsection\s+\d+-\d+", re.I),
    re.compile(r"§?\s*\b\d+-\d+\b"),                              # §5-19, 5-31
    re.compile(r"\bstep\s+\d+", re.I),
    re.compile(r"\b[A-Z]{1,3}\d+[A-Z]?\b"),                       # TP4, U2C, K11
]

UNIT = r"(?:V|A|F|H|W|Hz|ohms?|Ω|dB|s|%)"
SCALE = r"(?:k|K|m|M|u|U|µ|n|N|p|P)?"
NUM = r"[+-]?\d+(?:\.\d+)?"

# A bare quantity: "+0.3V", "220 mA", "1 kHz", "227 V dc".
QUANTITY = re.compile(
    r"(%s)\s*(%s)\s*(%s)\b(?:\s*(?:dc|ac|p-p|pp|rms))?" % (NUM, SCALE, UNIT), re.I)

# Shapes that are unambiguously an expectation rather than a stray number.
TOLERANCE = re.compile(r"(?:\+/-|\+-|±)\s*(%s)\s*(%s)(%s|%%)?" % (NUM, SCALE, UNIT), re.I)
RANGE = re.compile(
    r"\bbetween\s+(%s)\s*(%s)?\s*(%s)?\s+and\s+(%s)\s*(%s)?\s*(%s)?"
    % (NUM, SCALE, UNIT, NUM, SCALE, UNIT), re.I)

# A waveform expectation is real but is not a nominal +/- tolerance, and the
# schema says so with noPublishedValue rather than inventing a number.
WAVEFORM = re.compile(r"\b(square wave|sine|waveform|p-p|peak.to.peak|ramps?\b|oscillat)", re.I)


def mask_noise(text):
    """Blank out the numbers that are not expectations, keeping offsets."""
    out = text
    for pattern in NOISE:
        out = pattern.sub(lambda m: " " * len(m.group(0)), out)
    return out


def phrases(text):
    """Every candidate expectation in one step's prose, most specific first."""
    clean = mask_noise(text)
    found = []
    spans = []

    def take(match, kind):
        # A range subsumes the two quantities inside it; a tolerance subsumes
        # its own number. Record the span so the weaker pattern skips it.
        for lo, hi in spans:
            if match.start() >= lo and match.end() <= hi:
                return
        spans.append((match.start(), match.end()))
        found.append({"kind": kind, "text": match.group(0).strip()})

    for m in RANGE.finditer(clean):
        take(m, "range")
    for m in TOLERANCE.finditer(clean):
        take(m, "tolerance")
    for m in QUANTITY.finditer(clean):
        take(m, "quantity")
    return found


# ------------------------------------------------------------------ coverage

def cites_step(source, n):
    """
    Does this source string cite step n?

    Word-boundary matched on purpose. js/procedures.js:57 uses a bare
    indexOf('step ' + n), so 'step 1' also matches 'step 11' -- on a 44-step
    procedure like A11's that silently attaches four steps' expectations to
    one. This tool reports that overlap rather than reproducing it.
    """
    if not source:
        return False
    return re.search(r"\bstep\s+%d\b" % n, source, re.I) is not None


def naive_cites_step(source, n):
    """What js/procedures.js does today, for measuring the difference."""
    return bool(source) and ("step %d" % n) in source.lower()


def has_expectation(item):
    """Does this curated point carry something a reading can be scored against?"""
    def scored(d):
        return any(d.get(k) is not None
                   for k in ("nominal", "tolerance", "tolerancePct", "maxAbs", "lo", "hi"))
    if scored(item):
        return True
    return any(scored(s) for s in item.get("states") or [])


def points_of(dataset):
    out = []
    for tp in dataset.get("testpoints") or []:
        out.append(("test point", tp.get("ref") or tp.get("id") or "?", tp))
    for pp in dataset.get("probePoints") or []:
        out.append(("probe point", pp.get("id") or "?", pp))
    return out


# -------------------------------------------------------------------- report

def audit(asm, verbose=False):
    dataset = load(asm)
    if not dataset:
        print("%s: no data/%s.js" % (asm, asm))
        return 0

    points = points_of(dataset)
    procs = dataset.get("procedures") or []
    steps = [(p, s) for p in procs for s in p.get("steps") or []]

    print("=" * 72)
    print("%s  %s" % (dataset.get("id", asm.upper()), dataset.get("name", "")))
    print("  %d procedure step(s), %d test point(s), %d probe point(s)"
          % (len(steps), len(dataset.get("testpoints") or []),
             len(dataset.get("probePoints") or [])))
    print()

    uncovered = []
    waveform_only = []
    for proc, step in steps:
        n = step.get("n")
        text = step.get("text") or ""
        found = phrases(text)
        if not found:
            continue

        linked = [(kind, name, it) for kind, name, it in points
                  if cites_step(it.get("source"), n)]
        scored = [t for t in linked if has_expectation(t[2])]

        if scored and not verbose:
            continue

        where = "§%s step %s" % (step.get("section", proc.get("id", "?")), n)
        if scored:
            print("  %-18s covered by %s" % (where, ", ".join(t[1] for t in scored)))
            continue

        # Nothing scores this step. Distinguish a missed number from a
        # waveform, which is legitimately unscoreable.
        if WAVEFORM.search(text) and all(f["kind"] == "quantity" for f in found):
            waveform_only.append((where, found, linked))
        else:
            uncovered.append((where, found, linked))

    if uncovered:
        print("  Values in the prose with nothing to score them")
        print("  " + "-" * 68)
        for where, found, linked in uncovered:
            print("  %s" % where)
            for f in found:
                print("      %-10s %s" % (f["kind"], f["text"]))
            if linked:
                print("      (points cite this step but carry no expectation: %s)"
                      % ", ".join("%s %s" % (t[0], t[1]) for t in linked))
            else:
                print("      (no test point or probe point cites this step)")
        print()

    if waveform_only:
        print("  Waveform expectations -- noPublishedValue is the right answer")
        print("  " + "-" * 68)
        for where, found, _ in waveform_only:
            print("  %-18s %s" % (where, "; ".join(f["text"] for f in found)))
        print()

    # Sources that cite a step the procedure does not have. A citation like
    # "step 10" that resolves to nothing is a transcription slip worth seeing.
    valid = set(s.get("n") for _, s in steps)
    dangling = []
    for kind, name, item in points:
        for m in re.finditer(r"\bstep\s+(\d+)\b", item.get("source") or "", re.I):
            if int(m.group(1)) not in valid:
                dangling.append((kind, name, m.group(0)))
    if dangling:
        print("  Citations to a step that does not exist")
        print("  " + "-" * 68)
        for kind, name, cite in dangling:
            print("    %s %s cites %s" % (kind, name, cite))
        print()

    # The linkage bug, measured rather than asserted.
    overlaps = []
    for _, step in steps:
        n = step.get("n")
        for kind, name, item in points:
            src = item.get("source")
            if naive_cites_step(src, n) and not cites_step(src, n):
                overlaps.append((n, kind, name, src))
    if overlaps:
        print("  Mis-linked by js/procedures.js:57 (substring, no word boundary)")
        print("  " + "-" * 68)
        for n, kind, name, src in overlaps:
            print('    step %-3d wrongly picks up %s %s  (source: "%s")'
                  % (n, kind, name, src))
        print()

    print("  %d step(s) with an unscored value, %d waveform-only, %d mis-linked"
          % (len(uncovered), len(waveform_only), len(overlaps)))
    print()
    return len(uncovered)


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("assembly", nargs="*", help="a14, a18 ...")
    ap.add_argument("--all", action="store_true", help="every assembly in data/")
    ap.add_argument("--verbose", action="store_true",
                    help="also list steps that are already covered")
    args = ap.parse_args()

    names = args.assembly
    if args.all or not names:
        names = sorted(os.path.splitext(f)[0] for f in os.listdir(DATA)
                       if re.match(r"^a\d+\.js$", f))
    for asm in names:
        audit(asm, args.verbose)
    return 0


if __name__ == "__main__":
    sys.exit(main())
