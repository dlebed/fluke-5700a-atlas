#!/usr/bin/env python3
"""
fold_bundle.py — land an Author Mode bundle, whole, in one command.

Author Mode's "Export all boards" writes every edited board into one JSON.
This folds it: geometry into each board's overrides, then a rebuild, then the
integrity check, then one summary of what actually changed.

    tools/fold_bundle.py manual-data/a-author-bundle-2026-08-26.json --dry-run
    tools/fold_bundle.py manual-data/a-author-bundle-2026-08-26.json
    tools/fold_bundle.py .../bundle.json --drop-moved --only A9

It replaces unpack_export.py, which wrote data/<asm>.coords.json and
data/<asm>.js directly. Both of those are generated: build_coords.py rebuilds
the first from the reader plus the overrides, and assemble.py rebuilds the
second from the curated files plus the first. So an export unpacked into them
survived exactly until the next build and then vanished with nothing saying
so. An export folds through the overrides or it does not last, which is why
everything here goes via fold_overrides.py.

Four things this reports that nothing did before, each of them something a
previous fold got wrong or nearly did:

  first-time mappings   designators that had no schematic position at all.
                        This is usually the whole point of a round of work and
                        was previously invisible among the noise.

  nothing real changed  said out loud, per board. A bundle carries every board
                        that was open, and a round trip through JSON turns 1.0
                        into 1 and drifts coordinates by a fraction of a pixel.
                        Six of eight boards in one bundle were entirely that.
                        Without a line saying so, the next person diffs by hand
                        and mistakes formatting for edits.

  stale after a move    a move is an addition and nothing else: an override can
                        add a position and cannot withdraw the reader's own.
                        Move a marker to another sheet and the old one stays,
                        pointing at whatever is still there. A16 kept one on a
                        neighbouring part's designator text and it surfaced only
                        because an unrelated marker landed on top of it.

  edits coords can't carry
                        Author Mode edits record fields too -- signals, notes,
                        expectations. Those live in the curated files, and
                        assemble.py rebuilds the dataset from those, so a field
                        edited in the editor is discarded at the next assemble.
                        Nothing folds them; they are named here so they can be
                        copied across by hand before they are lost.

Nothing here writes a curated file or re-runs the reader.
"""

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TOOLS = os.path.join(ROOT, "tools")
DATA = os.path.join(ROOT, "data")
FORMAT = "fluke5700a.author.bundle"
SUPPORTED = (1,)

sys.path.insert(0, TOOLS)
# The two things worth borrowing rather than rewriting: the comparison that
# knows an override is integer pixels, and the dumper that keeps these files
# hand-editable. A json.dump round trip reformats an overrides file entirely
# and buries a one-word change in six hundred lines.
from fold_overrides import dumps_compact, same_box, same_sch   # noqa: E402

# What the coordinate half of the pipeline owns. Everything else on a record
# belongs to a curated file and cannot be folded from here.
GEOMETRY = {"board", "sch", "verified", "schVerified", "placement",
            "placementNote", "ref"}


def payload_of(path):
    """The dataset inside data/<asm>.js."""
    with open(path, encoding="utf-8") as fh:
        m = re.search(r"BoardExplorer\.register\((.*)\);\s*$", fh.read(), re.S)
    return json.loads(m.group(1)) if m else None


def index(dataset):
    out = {}
    for item in (dataset.get("components") or []):
        out[item["ref"]] = item
    for item in (dataset.get("testpoints") or []):
        out[item["ref"]] = item
    return out


def normalise(value):
    """
    1.0 and 1 are the same reading.

    JSON.stringify drops a trailing zero, so every whole-numbered expectation
    in a bundle differs textually from the file it came from. Compared raw,
    four test points looked edited in one bundle and not one of them was.
    """
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, list):
        return [normalise(v) for v in value]
    if isinstance(value, dict):
        return {k: normalise(v) for k, v in sorted(value.items())}
    return value


def sheets_of(item):
    return {occ.get("sheet") for occ in (item.get("sch") or [])}


def order(name):
    digits = re.sub(r"\D", "", name)
    return (int(digits) if digits else 0, name)


def survey(asm, exported_data, built):
    """
    What this board's half of the bundle actually says, beyond the geometry
    that fold_overrides.py will handle on its own.
    """
    cur, new = index(built), index(exported_data)
    first, moved_stale, field_edits = [], [], []

    for ref in sorted(set(cur) & set(new), key=order):
        before, after = cur[ref], new[ref]

        if not (before.get("sch") or []) and (after.get("sch") or []):
            first.append(ref)

        # A sheet it used to be on and is not any more. Only a reader's own
        # guess is a candidate: a hand-verified position that disappears from
        # an export is a deletion someone meant, and deletions are not
        # something this tool infers.
        for sheet in sorted(sheets_of(before) - sheets_of(after)):
            stale = [o for o in (before.get("sch") or [])
                     if o.get("sheet") == sheet and o.get("placement") != "verified"]
            if stale:
                moved_stale.append((ref, sheet, sorted(sheets_of(after))))

        for field in sorted((set(before) | set(after)) - GEOMETRY):
            a, b = normalise(before.get(field)), normalise(after.get(field))
            if a != b:
                field_edits.append((ref, field, before.get(field), after.get(field)))

    return {"first": first, "moved_stale": moved_stale, "field_edits": field_edits,
            "added": sorted(set(new) - set(cur), key=order),
            "removed": sorted(set(cur) - set(new), key=order)}


def fold_one(asm, coords, dry_run):
    """Hand this board's coordinates to fold_overrides.py and relay what it says."""
    fh = tempfile.NamedTemporaryFile("w", suffix=".coords.json", delete=False,
                                     encoding="utf-8")
    try:
        json.dump(coords, fh, indent=1)
        fh.close()
        cmd = [sys.executable, os.path.join(TOOLS, "fold_overrides.py"), asm, fh.name]
        if dry_run:
            cmd.append("--dry-run")
        done = subprocess.run(cmd, capture_output=True, text=True)
        return done.returncode, (done.stdout or "") + (done.stderr or "")
    finally:
        os.unlink(fh.name)


def apply_drops(asm, drops):
    """
    Add the stale occurrences to dropSchematic, which is the half of the
    overrides that removes. An explicit position outranks a drop for the same
    designator, so the placement the move created is unaffected.
    """
    path = os.path.join(DATA, "%s.coords.overrides.json" % asm)
    with open(path, encoding="utf-8") as fh:
        over = json.load(fh)
    bucket = over.setdefault("dropSchematic", {})
    written = []
    for ref, sheet, _ in drops:
        here = bucket.setdefault(sheet, [])
        if ref not in here:
            here.append(ref)
            # Plain alphabetical, which is how these lists are already kept --
            # U10 before U7. The numeric ordering used for assembly names would
            # regroup the whole list by trailing digit and put twenty lines of
            # reshuffling in the diff around one added designator.
            here.sort()
            written.append("%s on %s" % (ref, sheet))
    if written:
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(dumps_compact(over) + "\n")
    return written


def run(step, asm):
    cmd = ([sys.executable, os.path.join(TOOLS, step), asm] if step.endswith(".py")
           else ["node", os.path.join(TOOLS, step), asm])
    done = subprocess.run(cmd, capture_output=True, text=True)
    return done.returncode, (done.stdout or "") + (done.stderr or "")


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("bundle", help="the JSON written by Export all boards")
    ap.add_argument("--dry-run", action="store_true",
                    help="say what would happen and write nothing")
    ap.add_argument("--only", metavar="A9,A13", help="restrict to these assemblies")
    ap.add_argument("--drop-moved", action="store_true",
                    help="also retire reader positions left behind by a move")
    ap.add_argument("--no-build", action="store_true",
                    help="fold, but leave build_coords/assemble/check_data to you")
    args = ap.parse_args()

    with open(args.bundle, encoding="utf-8") as fh:
        bundle = json.load(fh)
    if bundle.get("format") != FORMAT:
        sys.exit("not an Author Mode bundle: format is %r" % bundle.get("format"))
    if bundle.get("version") not in SUPPORTED:
        sys.exit("bundle version %r is newer than this tool understands (%s)"
                 % (bundle.get("version"), ", ".join(str(v) for v in SUPPORTED)))

    wanted = None
    if args.only:
        wanted = {a.strip().upper() for a in args.only.split(",") if a.strip()}

    assemblies = bundle.get("assemblies") or {}
    if not assemblies:
        sys.exit("bundle carries no assemblies")

    print("bundle exported %s, %d board(s)"
          % (bundle.get("exportedAt", "at an unknown time"), len(assemblies)))
    if args.dry_run:
        print("dry run — nothing will be written")
    print()

    touched, notes, quiet = [], [], []
    for asm in sorted(assemblies, key=order):
        entry = assemblies[asm] or {}
        if wanted and asm.upper() not in wanted:
            continue
        if not entry.get("edited") and not wanted:
            continue

        low = asm.lower()
        built_path = os.path.join(DATA, "%s.js" % low)
        if not os.path.exists(built_path):
            print("  %-5s no data/%s.js — skipped" % (asm, low))
            continue

        look = survey(asm, entry.get("data") or {}, payload_of(built_path))
        code, out = fold_one(low, entry.get("coords") or {}, args.dry_run)
        if code != 0:
            print("  %-5s fold_overrides refused it:\n%s"
                  % (asm, "\n".join("      " + l for l in out.strip().splitlines())))
            continue

        folded = "nothing to fold" not in out
        if folded:
            touched.append(low)
        else:
            quiet.append(asm)

        headline = []
        if look["first"]:
            headline.append("%d first-time mapping%s"
                            % (len(look["first"]), "" if len(look["first"]) == 1 else "s"))
        if look["added"]:
            headline.append("%d new part%s"
                            % (len(look["added"]), "" if len(look["added"]) == 1 else "s"))
        if look["removed"]:
            headline.append("%d part%s gone"
                            % (len(look["removed"]), "" if len(look["removed"]) == 1 else "s"))
        if not folded and not headline:
            headline.append("nothing real changed — formatting and sub-pixel drift only")

        print("  %-5s %s" % (asm, "; ".join(headline) or "folded"))
        for line in out.strip().splitlines():
            if line.strip() and not line.startswith(("written.", "    tools/", "    node")):
                print("      " + line)
        if look["first"]:
            print("      first-time: %s" % ", ".join(look["first"]))

        if look["moved_stale"]:
            notes.append((asm, "moved", look["moved_stale"]))
        if look["field_edits"]:
            notes.append((asm, "fields", look["field_edits"]))

        if look["moved_stale"] and args.drop_moved and not args.dry_run:
            written = apply_drops(low, look["moved_stale"])
            if written:
                print("      retired: %s" % "; ".join(written))
                if low not in touched:
                    touched.append(low)
        print()

    if quiet:
        print("Nothing real in: %s\n" % ", ".join(quiet))

    for asm, kind, items in notes:
        if kind == "moved":
            print("%s — %d position%s left behind by a move:" % (asm, len(items),
                  "" if len(items) == 1 else "s"))
            for ref, sheet, now in items:
                print("    %s still on %s; the export puts it on %s"
                      % (ref, sheet, ", ".join(now) or "no sheet at all"))
            print("  A move adds a position and cannot withdraw the reader's own, so the\n"
                  "  old one stays and points at whatever is still there. Re-run with\n"
                  "  --drop-moved to retire them, or leave them if the part really is\n"
                  "  drawn on both sheets.\n")
        else:
            print("%s — %d field edit%s the coordinates cannot carry:" % (asm, len(items),
                  "" if len(items) == 1 else "s"))
            for ref, field, before, after in items[:20]:
                print("    %-8s %-14s %s  ->  %s"
                      % (ref, field, json.dumps(before)[:60], json.dumps(after)[:60]))
            if len(items) > 20:
                print("    ... and %d more" % (len(items) - 20))
            print("  assemble.py rebuilds the dataset from the curated files, so these are\n"
                  "  discarded at the next build unless they are copied into\n"
                  "  data/%s.testpoints.json or .reference.json by hand.\n" % asm.lower())

    if args.dry_run:
        print("--dry-run: nothing written")
        return
    if not touched:
        print("Nothing folded; nothing to rebuild.")
        return
    if args.no_build:
        print("Folded %s. Rebuild them when you are ready:\n"
              "    %s" % (", ".join(touched),
                          "; ".join("tools/build_coords.py %s && tools/assemble.py %s"
                                    % (a, a) for a in touched)))
        return

    print("Rebuilding %s\n" % ", ".join(touched))
    failed = []
    for asm in touched:
        for step in ("build_coords.py", "assemble.py"):
            code, out = run(step, asm)
            if code != 0:
                failed.append("%s %s" % (asm, step))
                print("  %-4s %-16s FAILED\n%s" % (asm, step,
                      "\n".join("      " + l for l in out.strip().splitlines()[-8:])))
        code, out = run("check_data.js", asm)
        tail = [l for l in out.strip().splitlines() if l.strip()]
        verdict = tail[-1] if tail else "(no output)"
        warned = [l for l in tail if "review each" in l or "still unplaced" in l]
        print("  %-4s %s%s" % (asm, verdict, "  [%s]" % "; ".join(warned) if warned else ""))
        if code != 0:
            failed.append("%s check_data" % asm)

    print()
    if failed:
        sys.exit("Rebuild problems: %s" % ", ".join(failed))
    print("Folded and rebuilt: %s" % ", ".join(touched))


if __name__ == "__main__":
    main()
