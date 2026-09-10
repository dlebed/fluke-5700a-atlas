#!/usr/bin/env python3
"""
Fold a capacitor voltage-derating audit into data/<asm>.caps.json.

The rated voltage is already in the parts list and is read from there at run
time; what a spreadsheet adds is the half no parts list can know -- which rail
each capacitor actually sits on, and how much energy is behind that rail. That
is a schematic question, answered by hand, and it is carried here with the
evidence for it rather than as a bare number.

Every row keeps its source ('schematic' or 'inferred') and its note. A row
whose rail was never traced is written with appliedV: null rather than left
out, because "not traced" is a fact worth showing -- an untraced rail is not
evidence that a part is safe.

    tools/import_cap_audit.py ../Research/Fluke_5700A_Tantalum_Audit.xlsx
    tools/import_cap_audit.py <xlsx> --dry-run
"""

import argparse
import json
import os
import re
import sys
import xml.etree.ElementTree as ET
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DATA = os.path.join(ROOT, "data")
NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}


def sheet_rows(path, want_name):
    """Rows of one worksheet as dicts keyed by column letter."""
    z = zipfile.ZipFile(path)
    book = ET.fromstring(z.read("xl/workbook.xml"))
    target = None
    for i, sh in enumerate(book.findall(".//m:sheet", NS), start=1):
        if sh.get("name") == want_name:
            target = "xl/worksheets/sheet%d.xml" % i
    if not target:
        raise SystemExit("no sheet named %r" % want_name)
    try:
        shared = ["".join(t.text or "" for t in si.iter("{%s}t" % NS["m"]))
                  for si in ET.fromstring(z.read("xl/sharedStrings.xml"))]
    except KeyError:
        shared = []
    ws = ET.fromstring(z.read(target))
    rows = []
    for row in ws.findall(".//m:sheetData/m:row", NS):
        cells = {}
        for c in row.findall("m:c", NS):
            col = re.match(r"([A-Z]+)", c.get("r")).group(1)
            v = c.find("m:v", NS)
            if c.get("t") == "s" and v is not None:
                cells[col] = shared[int(v.text)]
            elif v is not None:
                cells[col] = v.text
        rows.append(cells)
    return rows


def num(s):
    try:
        return float(s)
    except (TypeError, ValueError):
        return None


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("xlsx")
    ap.add_argument("--sheet", default="Detailed Analysis")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    rows = sheet_rows(args.xlsx, args.sheet)
    byasm = {}
    skipped = []
    for r in rows[1:]:
        board = (r.get("A") or "").strip()
        m = re.match(r"^(A\d+)", board)
        if not m:
            continue
        asm = m.group(1).lower()
        # One row can name several designators that share a rail.
        refs = [x for x in re.split(r"[,\s]+", (r.get("B") or "").strip())
                if re.match(r"^[A-Z]+\d+$", x)]
        if not refs:
            continue
        applied = num(r.get("D"))
        entry_base = {
            "net": (r.get("C") or "").strip() or None,
            "appliedV": applied,
            "railClass": (r.get("K") or "").strip() or None,
            "source": (r.get("L") or "").strip().lower() or None,
            "note": (r.get("M") or "").strip() or None,
        }
        # A rail the audit could not trace is recorded as untraced, not as zero.
        if entry_base["net"] in ("not traced", "unknown"):
            entry_base["net"] = None
        for ref in refs:
            byasm.setdefault(asm, {})[ref] = dict(entry_base)

    written = 0
    for asm in sorted(byasm):
        path = os.path.join(DATA, "%s.caps.json" % asm)
        dataset = os.path.join(DATA, "%s.js" % asm)
        if not os.path.exists(dataset):
            skipped.append((asm, len(byasm[asm])))
            continue
        doc = {
            "_comment": [
                "Which rail each capacitor sits on, and what that rail runs at.",
                "The rated voltage is NOT here -- it is read from the parts list",
                "at run time, so a corrected BOM corrects this too.",
                "",
                "source: 'schematic' means the net was traced on the Chapter 7",
                "sheet cited in the note; 'inferred' means it was deduced from",
                "the rails present at that slot and has not been read off a",
                "schematic. appliedV: null means the rail was never traced --",
                "shown as unknown rather than assumed safe.",
                "",
                "railClass is how much energy is behind the rail, which decides",
                "what a shorted part does: A is an unfused 3 A rail with a",
                "6600 uF reservoir, C is fused, E is a floating common.",
                "",
                "Generated by tools/import_cap_audit.py; hand edits are kept.",
            ],
            "assembly": asm.upper(),
            "caps": byasm[asm],
        }
        if args.dry_run:
            print("would write %-22s %3d caps" % (os.path.basename(path), len(byasm[asm])))
        else:
            with open(path, "w", encoding="utf-8") as f:
                json.dump(doc, f, indent=1, ensure_ascii=False)
                f.write("\n")
            print("wrote %-22s %3d caps" % (os.path.basename(path), len(byasm[asm])))
        written += 1

    if skipped:
        print("\nnot written -- no dataset for these assemblies yet:")
        for asm, n in skipped:
            print("  %-5s %3d caps" % (asm.upper(), n))
    return 0


if __name__ == "__main__":
    sys.exit(main())
