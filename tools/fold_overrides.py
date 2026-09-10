#!/usr/bin/env python3
"""
fold_overrides.py -- fold positions drawn in Author Mode back into the
overrides file, so the next build keeps them.

Author Mode exports data/<asm>.coords.json, which is exactly the file
build_coords.py regenerates from the reader plus the overrides. Export it and
rebuild and the work is gone. What survives a rebuild is
data/<asm>.coords.overrides.json -- and that is written in pixels of
.build/<asm>/drawing_full.png, which the browser has never seen: it loads
assets/<asm>/drawing.png, a downscale of it. Converting by hand means knowing
both sizes and getting the factor right for every box.

So this does it: read the export, keep only the entries that actually differ
from the built file, convert them to the pixels the overrides are measured in,
and merge them in without disturbing anything else in there.

    tools/fold_overrides.py a18 ~/Downloads/a18.coords.json
    tools/fold_overrides.py a18 ~/Downloads/a18.coords.json --dry-run

Board and schematic positions both. The two live in different places and are
measured in different pixels: board boxes go under "board" in pixels of
drawing_full.png, schematic boxes under "schematic": {"sh1": {...}} in pixels
of that sheet's own image, which is a different size per sheet.

The overrides take one hand position per designator per sheet, so a part drawn
twice on the same sheet cannot be expressed. Quietly keeping the first of the
two would be worse than saying so, and this refuses to fold that designator and
names it instead.
"""

import copy
import argparse
import collections
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

def load(path, what):
    if not os.path.exists(path):
        sys.exit("no %s at %s" % (what, path))
    with open(path) as fh:
        return json.load(fh, object_pairs_hook=collections.OrderedDict)


def in_pixels(box, size):
    """The box as the overrides would store it: whole pixels of its own image."""
    w, h = size
    scale = {"x": w, "y": h, "w": w, "h": h}
    return tuple(int(round((box.get(k) or 0) * scale[k])) for k in "xywh")


def same_box(a, b, size):
    """
    Two boxes are the same when an override cannot tell them apart.

    The comparison has to happen on the pixel grid the override is written in,
    not on the normalised numbers: the build rounds those to five decimals, but
    a sheet is only about 6000 px across, so one pixel is 1.6e-4 -- ten times
    the rounding. Comparing more finely than the file can store would report
    every folded position as edited again at the next export, for ever.
    """
    if not a or not b:
        return False
    if (a.get("shape") or "rect") != (b.get("shape") or "rect"):
        return False
    return in_pixels(a, size) == in_pixels(b, size)


def by_sheet(occurrences):
    out = collections.OrderedDict()
    for occ in occurrences or []:
        out.setdefault(occ.get("sheet"), []).append(occ)
    return out


def same_sch(a, b, size_of):
    """
    Compare schematic occurrence lists by where the boxes are, and nothing else.

    Comparing them as dicts looks stricter but is wrong twice over. Both sides
    are read as OrderedDicts, so a plain != would start calling every occurrence
    "edited" the day anyone reorders a key between build_coords.py and the
    browser. And the fields around the geometry do not survive a round trip
    anyway: a box drawn in Author Mode exports as shape/x/y/w/h, while the same
    box folded and rebuilt comes back as placement: "verified" with no shape.
    Position is what a person edits and what the override records.

    Occurrences are matched within a sheet by position rather than by index,
    because the order the build writes them in is not the order they were read.
    """
    ga, gb = by_sheet(a), by_sheet(b)
    if set(ga) != set(gb):
        return False
    order = lambda o: (o.get("x") or 0, o.get("y") or 0)
    for sheet, here in ga.items():
        there = gb[sheet]
        if len(here) != len(there):
            return False
        for x, y in zip(sorted(here, key=order), sorted(there, key=order)):
            if not same_box(x, y, size_of(sheet)):
                return False
    return True


def dumps_compact(obj, indent=2, level=0):
    """
    JSON that a person can still read and hand-edit afterwards.

    json.dump with an indent puts every key on its own line, which turns a
    position entry from one line into four and a 250-line overrides file into
    650. That matters here because these files are not machine output: they
    carry the reasoning for every correction in _comment blocks, they get edited
    by hand between folds, and a fold that reformats the whole file buries its
    one real change in six hundred lines of noise.

    So: a dict whose values are all scalars is one line -- that is exactly the
    shape of a position entry -- and a list of scalars is wrapped to width like
    the hand-written ones are. Everything else nests normally.
    """
    pad = " " * (indent * level)
    inner = " " * (indent * (level + 1))
    if isinstance(obj, dict):
        if not obj:
            return "{}"
        if all(not isinstance(v, (dict, list)) for v in obj.values()):
            one = "{ " + ", ".join("%s: %s" % (json.dumps(k), json.dumps(v))
                                   for k, v in obj.items()) + " }"
            if len(pad) + len(one) <= 160:
                return one
        parts = ["%s%s: %s" % (inner, json.dumps(k),
                               dumps_compact(v, indent, level + 1))
                 for k, v in obj.items()]
        return "{\n" + ",\n".join(parts) + "\n" + pad + "}"
    if isinstance(obj, list):
        if not obj:
            return "[]"
        if all(not isinstance(x, (dict, list)) for x in obj):
            toks = [json.dumps(x) for x in obj]
            joined = ", ".join(toks)
            if len(pad) + len(joined) + 2 <= 96:
                return "[" + joined + "]"
            lines, cur = [], []
            for t in toks:
                if cur and len(inner) + len(", ".join(cur + [t])) > 76:
                    lines.append(inner + ", ".join(cur) + ",")
                    cur = [t]
                else:
                    cur.append(t)
            if cur:
                lines.append(inner + ", ".join(cur))
            return "[\n" + "\n".join(lines) + "\n" + pad + "]"
        parts = [inner + dumps_compact(x, indent, level + 1) for x in obj]
        return "[\n" + ",\n".join(parts) + "\n" + pad + "]"
    return json.dumps(obj)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("assembly")
    ap.add_argument("export", help="the coords.json exported from Author Mode")
    ap.add_argument("--dry-run", action="store_true",
                    help="say what would change and write nothing")
    # Re-aligning a photo and correcting a marker are different jobs, and an
    # export carries both because Author Mode dumps the whole board. Someone who
    # spent an afternoon on outlines should be able to take just the outlines,
    # rather than having to remember which designators they happened to nudge
    # while they were in there.
    ap.add_argument("--layers-only", action="store_true",
                    help="fold the photo/overlay alignment and leave every "
                         "marker position alone")
    args = ap.parse_args()

    asm = args.assembly.lower()
    build_dir = os.path.join(ROOT, ".build", asm)
    ocr = load(os.path.join(build_dir, "ocr_board.json"), "board OCR pass")
    W, H = ocr["width"], ocr["height"]

    exported = load(args.export, "export")
    if (exported.get("assembly") or "").lower() != asm:
        sys.exit("that export is for %s, not %s" % (exported.get("assembly"), asm))
    built = load(os.path.join(ROOT, "data", "%s.coords.json" % asm), "built coords")

    over_path = os.path.join(ROOT, "data", "%s.coords.overrides.json" % asm)
    over = load(over_path, "overrides")
    # Kept so --layers-only can write the file back exactly as it was apart from
    # the alignment, rather than trusting that the marker passes below left it
    # alone.
    pristine = copy.deepcopy(over)
    declared = over.get("imageSize") or {}
    if declared and (declared.get("w") != W or declared.get("h") != H):
        sys.exit("the overrides are measured against %sx%s but the drawing is %dx%d"
                 % (declared.get("w"), declared.get("h"), W, H))
    board = over.setdefault("board", collections.OrderedDict())

    # Each sheet has its own size, and the two sheets of one figure are not
    # necessarily the same -- A17's were scanned about 3% apart. Take the sizes
    # from the OCR pass rather than from the declaration in the overrides, for
    # the reason build_coords.py does: the image is the fact, the declaration is
    # a claim about it. Where the file makes that claim, hold it to it -- a
    # mismatch means the sheets were re-extracted at a different size and every
    # existing override on that sheet is already wrong.
    sheet_size = {}

    def size_of(sheet):
        if sheet not in sheet_size:
            sheet_ocr = load(os.path.join(build_dir, "ocr_%s.json" % sheet),
                             "%s OCR pass" % sheet)
            sw, sh = sheet_ocr["width"], sheet_ocr["height"]
            stated = over.get("sheetImageSize") or {}
            stated = stated.get(sheet, stated) if stated else {}
            if stated and (stated.get("w") != sw or stated.get("h") != sh):
                sys.exit("the overrides put %s at %sx%s but the sheet is %dx%d"
                         % (sheet, stated.get("w"), stated.get("h"), sw, sh))
            sheet_size[sheet] = (sw, sh)
        return sheet_size[sheet]

    added, changed, sch_edited = [], [], []
    for ref, entry in (exported.get("placement") or {}).items():
        base = (built.get("placement") or {}).get(ref) or {}
        if entry.get("sch") and not same_sch(entry["sch"], base.get("sch"), size_of):
            sch_edited.append((ref, entry["sch"]))
        box = entry.get("board")
        if not box or same_box(box, base.get("board"), (W, H)):
            continue

        # Keep whatever else the entry already carried -- a note explaining the
        # position, the 'fitted' flag from the body-fitting pass -- and replace
        # only the geometry. 'row' is a shorthand for a default width and
        # height, so it goes once those are stated outright.
        existing = board.get(ref)
        merged = collections.OrderedDict(existing) if existing else collections.OrderedDict()
        merged.pop("row", None)
        merged["x"] = int(round(box["x"] * W))
        merged["y"] = int(round(box["y"] * H))
        merged["w"] = int(round(box["w"] * W))
        merged["h"] = int(round(box["h"] * H))
        merged["shape"] = box.get("shape") or "rect"
        board[ref] = merged
        (changed if existing else added).append(ref)

    # Schematic occurrences, into "schematic": {"<sheet>": {...}}, in the pixels
    # of that sheet's own image. Only one position per designator per sheet fits
    # there, so a designator drawn twice on one sheet is named and left alone.
    sch_added, sch_changed, sch_ambiguous = [], [], []
    for ref, occurrences in sch_edited:
        counts = collections.Counter(o.get("sheet") for o in occurrences)
        twice = sorted(sheet for sheet, n in counts.items() if n > 1)
        if twice:
            sch_ambiguous.append((ref, twice))
            continue
        for occ in occurrences:
            sheet = occ.get("sheet")
            x, y, w, h = in_pixels(occ, size_of(sheet))
            sch_over = over.setdefault("schematic", collections.OrderedDict())
            here = sch_over.setdefault(sheet, collections.OrderedDict())
            # Keep a note already written against this position and replace only
            # the geometry, exactly as the board path does.
            existing = here.get(ref)
            merged = collections.OrderedDict(existing) if existing else collections.OrderedDict()
            merged["x"], merged["y"], merged["w"], merged["h"] = x, y, w, h
            here[ref] = merged
            (sch_changed if existing else sch_added).append("%s %s" % (ref, sheet))

    # A position cleared in Author Mode leaves no "board" key in the export --
    # there is no tombstone to fold. Folding therefore cannot see it, and the
    # stale override would survive, rebuild itself, and put the marker the
    # reviewer just rejected straight back on the board with nothing said. So
    # look for the absence directly, and say so; what should replace it is a
    # judgement (drop it, mark it notOnDrawing, or leave the reader to place
    # it) that this tool has no business making on its own.
    placement = exported.get("placement") or {}
    cleared = [ref for ref in board
               if not (placement.get(ref) or {}).get("board")]

    # ---- layer alignment --------------------------------------------------
    # The photo homography is not a position and belongs to no designator, so
    # it folds on its own terms: build_coords.py re-solves H from the landmark
    # pairs at every build, which makes the pairs the thing worth keeping and H
    # itself disposable. Author Mode writes them under layers.<id>.landmarks.
    # Without this they reached the export and stopped there -- the alignment
    # held until the next build and then quietly reverted to whatever the
    # overrides file still said.
    layers_added, layers_changed = [], []
    for layer_id, spec in (exported.get("layers") or {}).items():
        pairs = [p for p in (spec.get("landmarks") or []) if p.get("src") and p.get("dst")]
        if not pairs:
            continue
        # Landmarks are normalised, not pixels, so there is no image grid to
        # snap them to; five places is finer than any board is wide in pixels,
        # and rounding keeps a re-fold from reporting float noise as an edit.
        rounded = []
        for p in pairs:
            entry = {}
            if p.get("note"):
                entry["note"] = p["note"]
            entry["src"] = [round(float(p["src"][0]), 5), round(float(p["src"][1]), 5)]
            entry["dst"] = [round(float(p["dst"][0]), 5), round(float(p["dst"][1]), 5)]
            rounded.append(entry)
        pairs = rounded
        if len(pairs) < 4:
            print("  %s: %d landmark pair(s) -- a homography needs 4, not folded"
                  % (layer_id, len(pairs)))
            continue
        old = ((over.get("layers") or {}).get(layer_id) or {}).get("landmarks")
        if old == pairs:
            continue
        over.setdefault("layers", {}).setdefault(layer_id, {})["landmarks"] = pairs
        (layers_changed if old else layers_added).append(
            "%s, %d pairs%s" % (layer_id, len(pairs),
                                "" if not old else " (was %d)" % len(old)))

    held_back = 0
    if args.layers_only:
        held_back = len(added) + len(changed) + len(sch_added) + len(sch_changed)
        kept = over.get("layers")
        over = pristine
        if kept:
            over["layers"] = kept
        added, changed, sch_added, sch_changed = set(), set(), set(), set()
        cleared, sch_ambiguous = set(), []

    total = (len(added) + len(changed) + len(sch_added) + len(sch_changed)
             + len(layers_added) + len(layers_changed))
    if not total:
        # "Nothing to fold" has to stop meaning "nothing to do" when something
        # was cleared, or the reader takes it as done and stops reading.
        print("nothing to fold: every position in that export already "
              "matches data/%s.coords.json" % asm
              if not (cleared or sch_ambiguous) else
              "no position needs folding, but see below")
    else:
        print("%d change%s to fold into data/%s.coords.overrides.json"
              % (total, "" if total == 1 else "s", asm))
        if layers_added:
            print("  layer, new      %s" % "; ".join(layers_added))
        if layers_changed:
            print("  layer, replaced %s" % "; ".join(layers_changed))
        if added:
            print("  board, new      %s" % " ".join(sorted(added)))
        if changed:
            print("  board, replaced %s" % " ".join(sorted(changed)))
        if sch_added:
            print("  sheet, new      %s" % ", ".join(sorted(sch_added)))
        if sch_changed:
            print("  sheet, replaced %s" % ", ".join(sorted(sch_changed)))

    if held_back:
        print("\n--layers-only: %d marker change%s in that export left unfolded."
              % (held_back, "" if held_back == 1 else "s"))

    if cleared:
        print("\n%d designator%s cleared in Author Mode but still overridden here:\n    %s\n"
              "Folding cannot express a deletion, so %s untouched and will come back\n"
              "at the next build. Decide what each one should be and edit by hand:\n"
              "  - delete the entry     the reader places it again from OCR\n"
              "  - add it to \"drop\"     the reader's hit is discarded too\n"
              "  - \"notOnDrawing\"       there is no silkscreen for it at all"
              % (len(cleared), "" if len(cleared) == 1 else "s", " ".join(sorted(cleared)),
                 "it is" if len(cleared) == 1 else "they are"))

    if sch_ambiguous:
        print("\n%d designator%s drawn more than once on one sheet, and left alone:\n    %s\n"
              "An override holds one position per designator per sheet, so folding these\n"
              "would keep one occurrence and silently discard the rest. Place the one that\n"
              "matters by hand under \"schematic\", in pixels of that sheet's own image."
              % (len(sch_ambiguous), "" if len(sch_ambiguous) == 1 else "s",
                 "    ".join("%s on %s" % (ref, " and ".join(sheets))
                             for ref, sheets in sorted(sch_ambiguous))))

    if args.dry_run:
        print("\n--dry-run: nothing written")
        return
    if not total:
        return

    with open(over_path, "w") as fh:
        fh.write(dumps_compact(over) + "\n")
    print("\nwritten. Now rebuild and look at it:\n"
          "    tools/build_coords.py %s && tools/assemble.py %s\n"
          "    node tools/check_data.js %s" % (asm, asm, asm))


if __name__ == "__main__":
    main()
