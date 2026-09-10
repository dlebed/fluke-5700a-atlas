#!/usr/bin/env python3
"""
vlm_crosscheck.py — read the drawing a second time with a different kind of
reader, and reconcile the two.

tesseract and a vision-language model fail differently, which is the whole point.
tesseract segments connected components, so a designator whose glyphs touch the
component outline is invisible to it -- that is why A17 yields 47% where A18
yields far more. A VLM does not segment, and reads those labels fine. What it
cannot do is say precisely where they are: asked for coordinates it answers to
about a label's width, which locates a marker but does not place one.

So the two are used for what each is good at. tesseract owns geometry. The VLM
owns "which designators are on this tile", and its answer is worth having for
three things:

  * a designator tesseract missed entirely becomes a hand-placement candidate
    with a tile to look in, instead of a name on a list of 102 unplaced parts;
  * a designator tesseract placed but the VLM cannot see is worth a second look;
  * a designator the VLM names that is not on this board's parts list is a
    measured hallucination, which is how the reader's trustworthiness stops
    being a matter of opinion.

The model is reached over MCP, which a script cannot call, so this runs in two
halves with the agent in between:

    tools/vlm_crosscheck.py plan  a17 board --grid 6x4
        writes the tiles and .build/a17/vlm/board/manifest.json

    ... the agent asks the model about each tile and fills in answers.json ...

    tools/vlm_crosscheck.py merge a17 board
        reconciles, scores, and writes report.txt

Nothing here writes coordinates. It produces candidates and evidence; placement
stays a human decision, which is the same rule the rest of the pipeline follows.
"""

import argparse
import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

sys.path.insert(0, HERE)
import spaces      # noqa: E402  -- needs HERE on the path first

# Overlap so a designator sitting on a seam is whole in at least one tile.
OVERLAP = 0.10

QUESTION = (
    "This is a crop of a printed circuit board component-locator drawing. "
    "Most silkscreen designators are rotated 90 degrees and read bottom-to-top. "
    "List every component designator you can actually read, one per line, "
    "nothing else. Designators look like C13, CR7, R231, U56, TP12, VR3, Z1. "
    "Do not list a designator you cannot read, and do not guess at ones that are "
    "cut off at the edge."
)

SCHEMATIC_QUESTION = (
    "This is a crop of an electronic schematic sheet. List every component "
    "reference designator printed on it, one per line, nothing else. Designators "
    "look like C13, CR7, R231, U56, TP12, VR3, Z1. Ignore pin numbers, net names, "
    "component values and part numbers. Do not list a designator you cannot read."
)


def load(path, default=None):
    if not os.path.exists(path):
        return default
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def known_designators(asm):
    """The authoritative set, from the built dataset -- same source the reader uses."""
    path = os.path.join(ROOT, "data", "%s.js" % asm)
    if not os.path.exists(path):
        sys.exit("no data/%s.js -- run tools/assemble.py first" % asm)
    text = open(path, encoding="utf-8").read()
    data = json.loads(text[text.index("register(") + 9:text.rindex(");")])
    return {c["ref"] for c in data["components"]} | {t["ref"] for t in data["testpoints"]}


def work_dir(asm, space):
    return os.path.join(ROOT, ".build", asm, "vlm", space)


def plan(asm, space, grid, only, scale):
    src = spaces.require(os.path.join(ROOT, ".build", asm), space)
    nx, ny = (int(v) for v in grid.lower().split("x"))
    out = work_dir(asm, space)
    os.makedirs(out, exist_ok=True)

    dims = subprocess.run(["magick", "identify", "-format", "%w %h", src],
                          capture_output=True, text=True).stdout.split()
    W, H = int(dims[0]), int(dims[1])
    tw, th = W / nx, H / ny
    px, py = tw * OVERLAP, th * OVERLAP

    tiles = []
    for ry in range(ny):
        for rx in range(nx):
            tid = "r%dc%d" % (ry, rx)
            if only and tid not in only:
                continue
            x0 = max(0, int(rx * tw - px))
            y0 = max(0, int(ry * th - py))
            x1 = min(W, int((rx + 1) * tw + px))
            y1 = min(H, int((ry + 1) * th + py))
            dest = os.path.join(out, "tile_%s.png" % tid)
            subprocess.run(
                ["magick", src, "-crop", "%dx%d+%d+%d" % (x1 - x0, y1 - y0, x0, y0),
                 "+repage", "-filter", "Lanczos", "-resize", "%d%%" % scale, dest],
                check=True)
            tiles.append({"id": tid, "file": dest,
                          "box": [round(x0 / W, 5), round(y0 / H, 5),
                                  round(x1 / W, 5), round(y1 / H, 5)]})

    manifest = {
        "assembly": asm, "space": space, "grid": grid,
        "imageSize": {"w": W, "h": H},
        "question": SCHEMATIC_QUESTION if space != "board" else QUESTION,
        "tiles": tiles,
    }
    with open(os.path.join(out, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=1)

    print("%d tiles in %s" % (len(tiles), out))
    print("Ask the model the manifest's question about each tile, then write")
    print("  %s" % os.path.join(out, "answers.json"))
    print('  {"r0c0": ["C13","CR7"], "r0c1": [...]}   -- one entry per tile')
    print("Then: tools/vlm_crosscheck.py merge %s %s" % (asm, space))


def in_box(hit, box, margin=0.0):
    x0, y0, x1, y1 = box
    return (x0 - margin) <= hit["x"] <= (x1 + margin) and \
           (y0 - margin) <= hit["y"] <= (y1 + margin)


def merge(asm, space):
    out = work_dir(asm, space)
    manifest = load(os.path.join(out, "manifest.json"))
    if not manifest:
        sys.exit("no manifest -- run 'plan' first")
    answers = load(os.path.join(out, "answers.json"))
    if answers is None:
        sys.exit("no answers.json in %s -- see the instructions 'plan' printed" % out)

    ocr = load(os.path.join(ROOT, ".build", asm, "ocr_%s.json" % space), {"hits": {}})
    hits = ocr.get("hits", {})
    known = known_designators(asm)
    coords = load(os.path.join(ROOT, "data", "%s.coords.json" % asm), {}) or {}
    placement = coords.get("placement", {})

    def placed_here(ref):
        p = placement.get(ref, {})
        return bool(p.get("board")) if space == "board" else \
            any(s.get("sheet") == space for s in p.get("sch", []))

    lines, invented, confirmed, vlm_only, ocr_only = [], [], [], [], []
    truncated, degenerate, sectioned = [], [], []
    tiles_by_id = {t["id"]: t for t in manifest["tiles"]}

    for tid, refs in sorted(answers.items()):
        tile = tiles_by_id.get(tid)
        if not tile:
            lines.append("%s: not in the manifest, ignored" % tid)
            continue
        box = tile["box"]
        raw = [r.strip().upper().replace(" ", "") for r in refs if r and r.strip()]
        # A schematic names the sections of a multi-part device separately: the
        # four op amps in U2 are U2A..U2D, a two-form-C relay's contacts are
        # K14A and K14B. Those are correct readings of what is printed, so they
        # resolve to their device rather than counting against the model.
        resolved = []
        for r in raw:
            if r not in known and len(r) > 1 and r[-1].isalpha() and r[:-1] in known:
                sectioned.append((tid, r, r[:-1]))
                r = r[:-1]
            resolved.append(r)
        raw = resolved
        said = set(raw)
        # Repeating the same run of designators is how this model degenerates --
        # the older one did it at book length, this one does it a few times. A
        # name given twice for one tile is a symptom, not extra evidence.
        repeats = len(raw) - len(said)
        # Anything the model names that is not a designator on this board is a
        # false positive, full stop. No snapping, no edit distance -- the point
        # of the measurement is lost if a wrong answer is quietly repaired.
        bogus = sorted(r for r in said if r not in known)
        real = said - set(bogus)
        here = {r for r, h in hits.items() if in_box(h, box)}
        # Most of what fails the known-set test is a dropped leading letter
        # rather than an invention: 'R3' for CR3, '69' for C69. Saying which is
        # which keeps the hallucination figure meaningful.
        for r in bogus:
            for pre in ("C", "CR", "VR", "TP", "MP", "R", "U", "Z", "Q"):
                if pre + r in known:
                    truncated.append((tid, r, pre + r))
                    break

        invented += [(tid, r) for r in bogus]
        confirmed += [(tid, r) for r in sorted(real & here)]
        vlm_only += [(tid, r) for r in sorted(real - here)]
        ocr_only += [(tid, r) for r in sorted(here - real)]

        if repeats:
            degenerate.append((tid, repeats))
        lines.append("%s  model %d (%d not on this board%s)  reader %d  agreed %d"
                     % (tid, len(said), len(bogus),
                        ", %d repeats" % repeats if repeats else "",
                        len(here), len(real & here)))

    report = []
    report.append("VLM cross-check — %s %s" % (asm.upper(), space))
    report.append("=" * 60)
    report.extend(lines)
    report.append("")

    total_said = len(invented) + len(confirmed) + len(vlm_only)
    trunc_map = {(t, r): full for t, r, full in truncated}
    real_inventions = [(t, r) for t, r in invented if (t, r) not in trunc_map]
    report.append("HALLUCINATION RATE")
    report.append("  %d of %d names the model gave are not designators on this board"
                  % (len(invented), total_said))
    if truncated:
        report.append("  %d of those are a real label with its leading letter dropped:"
                      % len(truncated))
        report.append("    " + " ".join("%s->%s" % (r, full) for _, r, full in truncated))
    if sectioned:
        seen = sorted({"%s->%s" % (r, dev) for _, r, dev in sectioned})
        report.append("  %d were a section of a multi-part device, which is what the "
                      "sheet prints:" % len(sectioned))
        report.append("    " + " ".join(seen))
    report.append("  %d are inventions with no obvious source" % len(real_inventions))
    if real_inventions:
        report.append("    " + " ".join("%s@%s" % (r, t) for t, r in real_inventions))
    if degenerate:
        report.append("  DEGENERATE OUTPUT — the model repeated itself on: "
                      + " ".join("%s(%dx)" % (t, n) for t, n in degenerate))
        report.append("    Repetition is the failure mode to watch. Re-ask those tiles.")
    report.append("")

    report.append("AGREED — reader and model both saw it (%d)" % len(confirmed))
    report.append("  " + " ".join(r for _, r in confirmed) if confirmed else "  none")
    report.append("")

    unplaced = [(t, r) for t, r in vlm_only if not placed_here(r)]
    already = [(t, r) for t, r in vlm_only if placed_here(r)]
    report.append("MODEL ONLY, AND STILL UNPLACED — hand-placement candidates (%d)"
                  % len(unplaced))
    for tid, ref in unplaced:
        b = tiles_by_id[tid]["box"]
        W, H = manifest["imageSize"]["w"], manifest["imageSize"]["h"]
        report.append("  %-7s %s   look in x %d..%d, y %d..%d px"
                      % (ref, tid, b[0] * W, b[2] * W, b[1] * H, b[3] * H))
    if not unplaced:
        report.append("  none")
    report.append("")
    if already:
        report.append("MODEL ONLY, BUT ALREADY PLACED ELSEWHERE — check for a duplicate "
                      "or a mis-tiled read (%d)" % len(already))
        report.append("  " + " ".join("%s@%s" % (r, t) for t, r in already))
        report.append("")

    report.append("READER ONLY — the model did not see these, worth a second look (%d)"
                  % len(ocr_only))
    report.append("  " + " ".join("%s@%s" % (r, t) for t, r in ocr_only)
                  if ocr_only else "  none")

    text = "\n".join(report) + "\n"
    with open(os.path.join(out, "report.txt"), "w") as f:
        f.write(text)
    print(text)
    print("written to %s" % os.path.join(out, "report.txt"))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("action", choices=["plan", "merge"])
    ap.add_argument("assembly")
    ap.add_argument("space", help="board, or sh1 / sh2 / ... for a schematic sheet")
    ap.add_argument("--grid", default="6x4", help="tiles across x down (default 6x4)")
    ap.add_argument("--tiles", nargs="*", help="only these tile ids, e.g. r0c0 r1c3")
    ap.add_argument("--scale", type=int, default=200, help="upscale percent (default 200)")
    args = ap.parse_args()
    asm = args.assembly.lower()
    if args.action == "plan":
        plan(asm, args.space, args.grid, set(args.tiles or []), args.scale)
    else:
        merge(asm, args.space)


if __name__ == "__main__":
    main()
