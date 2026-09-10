#!/usr/bin/env python3
"""
ocr_designators.py — seed component positions by reading the silkscreen.

The board drawing and the schematic sheets both label every part with its
designator, so the label's own bounding box is the position worth recording:
it is where a person looks to find the part, and it comes from the image itself
rather than from anyone's estimate.

Two things make a plain tesseract pass insufficient, and both are handled here:

  * Silkscreen text runs horizontally *and* rotated 90 degrees, roughly half
    and half, so the image is read at both orientations and the boxes from the
    rotated pass are mapped back.
  * Recognition of small isolated tokens is noisy, so every candidate is
    matched against the authoritative designator list from the parts list.
    A token that is not a real designator on this board is discarded, and a
    near miss ('VREL3', 'R2320') is snapped to the designator it can only be.

Output: .build/<asm>/ocr_<space>.json, positions normalised 0..1.

Usage: tools/ocr_designators.py <asm> <space>      space = board | sh1 | sh2 | ...
"""

import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

sys.path.insert(0, HERE)
import spaces      # noqa: E402  -- needs HERE on the path first

# Tiling: tesseract's layout analysis works better on a region than on a whole
# A3 sheet, and the overlap keeps a label that straddles a seam readable.
#
# Several passes are run and their results unioned. A label that one tiling
# splits awkwardly usually falls cleanly inside a tile of another, and the
# unthresholded pass recovers thin strokes that binarising eats. Each pass is
# (tiles across, tiles down, upscale, threshold-or-None).
PASSES = [
    (6, 4, 2, "62%"),
    (10, 7, 3, "62%"),
    (10, 7, 3, None),
    (14, 9, 4, "55%"),
]
OVERLAP = 0.16

VALID_PREFIX = ("CR", "VR", "RT", "MP", "TP", "C", "R", "Q", "U", "Z",
                "F", "J", "K", "H", "P", "S", "W")

# Digits and letters the scan confuses, applied only to the half of the token
# where the confusion is possible.
DIGIT_FIXES = str.maketrans({"O": "0", "Q": "0", "D": "0", "I": "1", "L": "1",
                             "S": "5", "B": "8", "Z": "2", "G": "6", "T": "7"})
ALPHA_FIXES = str.maketrans({"0": "O", "1": "I", "5": "S", "8": "B", "6": "G"})


def run(cmd, **kw):
    return subprocess.run(cmd, check=True, capture_output=True, text=True, **kw)


def known_designators(asm):
    """The authoritative designator set, read back out of the built dataset."""
    path = os.path.join(ROOT, "data", "%s.js" % asm)
    text = open(path, encoding="utf-8").read()
    data = json.loads(text[text.index("register(") + 9:text.rindex(");")])
    refs = [c["ref"] for c in data["components"]]
    refs += [t["ref"] for t in data["testpoints"]]
    return set(refs)


def levenshtein(a, b):
    if a == b:
        return 0
    if abs(len(a) - len(b)) > 2:
        return 3
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def canonicalise(token, known):
    """Map a raw OCR token onto a real designator, or None."""
    t = re.sub(r"[^A-Za-z0-9]", "", token).upper()
    if len(t) < 2 or len(t) > 7:
        return None

    # Split into a prefix and a number, then repair each half on its own terms:
    # a rounded glyph read as '0' in the prefix is a letter, and an 'S' inside
    # the number is a 5. The prefix is ambiguous enough ('0' is O, Q, C or U in
    # this typeface) that every plausible reading is tried against the known set.
    candidates = [t]
    m = re.match(r"^([A-Z0-9]{1,2}?)([0-9OQDILSBZGT]+)$", t)
    if m:
        digits = m.group(2).translate(DIGIT_FIXES)
        if digits.isdigit():
            number = str(int(digits))
            raw_prefix = m.group(1)
            prefixes = {raw_prefix, raw_prefix.translate(ALPHA_FIXES)}
            if "0" in raw_prefix:
                for letter in "OQCU":
                    prefixes.add(raw_prefix.replace("0", letter))
            if "1" in raw_prefix:
                for letter in "IJT":
                    prefixes.add(raw_prefix.replace("1", letter))
            for prefix in prefixes:
                candidates.append(prefix + number)

    for cand in candidates:
        if cand in known:
            return cand

    # Near miss: accept only when exactly one known designator is within one
    # edit and shares the first character, so nothing is silently guessed.
    best = [k for k in known
            if k[0] == t[0] and levenshtein(t, k) <= 1]
    if len(best) == 1:
        return best[0]
    return None


def ocr_tile(path):
    """
    Read one tile and return [(token, left, top, width, height, conf)].

    Both page-segmentation modes are used and their results unioned: 11 treats
    the tile as scattered text, which suits isolated silkscreen labels, while 6
    assumes a block and picks up labels that 11 skips. No character whitelist --
    it measurably suppresses recognition with the LSTM engine.
    """
    rows = []
    for psm in ("11", "6"):
        try:
            out = run(["tesseract", path, "stdout", "--psm", psm, "tsv"]).stdout
        except subprocess.CalledProcessError:
            continue
        for line in out.split("\n")[1:]:
            parts = line.split("\t")
            if len(parts) < 12 or not parts[11].strip():
                continue
            try:
                left, top, width, height = (int(parts[6]), int(parts[7]),
                                            int(parts[8]), int(parts[9]))
                conf = float(parts[10])
            except ValueError:
                continue
            if conf < 25:
                continue
            rows.append((parts[11].strip(), left, top, width, height, conf))
    return rows


def collect(asm, space):
    build = os.path.join(ROOT, ".build", asm)
    src = spaces.require(build, space)

    size = run(["magick", "identify", "-format", "%w %h", src]).stdout.split()
    W, H = int(size[0]), int(size[1])
    known = known_designators(asm)

    work = os.path.join(build, "ocr_tiles_%s" % space)
    os.makedirs(work, exist_ok=True)

    # Every hit from every pass is kept rather than only the best one. Four
    # passes read the sheet with different tiling, scaling and thresholds, so
    # whether they independently land on the same spot is a free and honest
    # measure of confidence -- and it is the check that catches the failure
    # that matters, a label attached to the wrong designator.
    hits = {}   # ref -> [(conf, x, y, w, h, rot)]

    for pass_no, (nx, ny, upscale, threshold) in enumerate(PASSES):
        before = len(hits)
        tile_w = W / nx
        tile_h = H / ny
        pad_x = tile_w * OVERLAP
        pad_y = tile_h * OVERLAP

        for ty in range(ny):
            for tx in range(nx):
                x0 = max(0, int(tx * tile_w - pad_x))
                y0 = max(0, int(ty * tile_h - pad_y))
                x1 = min(W, int((tx + 1) * tile_w + pad_x))
                y1 = min(H, int((ty + 1) * tile_h + pad_y))
                tw, th = x1 - x0, y1 - y0

                base = os.path.join(work, "p%d_t%d_%d" % (pass_no, tx, ty))
                crop = base + ".png"
                cmd = ["magick", src, "-crop", "%dx%d+%d+%d" % (tw, th, x0, y0), "+repage",
                       "-resize", "%d%%" % (upscale * 100), "-colorspace", "Gray"]
                if threshold:
                    cmd += ["-threshold", threshold]
                run(cmd + [crop])

                for rot in (0, 90):
                    if rot:
                        # Silkscreen set vertically reads bottom-to-top, so the
                        # tile is turned clockwise to bring it upright.
                        target = base + "_r90.png"
                        run(["magick", crop, "-rotate", "90", target])
                    else:
                        target = crop

                    for token, left, top, width, height, conf in ocr_tile(target):
                        ref = canonicalise(token, known)
                        if not ref:
                            continue
                        if rot == 0:
                            px, py, pw, ph = left, top, width, height
                        else:
                            # Rotating an H-tall tile 90 deg clockwise sends
                            # (x, y) to (H-1-y, x); this is the inverse for a box.
                            px = top
                            py = th * upscale - left - width
                            pw, ph = height, width
                        cx = x0 + (px + pw / 2) / upscale
                        cy = y0 + (py + ph / 2) / upscale
                        hits.setdefault(ref, []).append(
                            (conf, cx / W, cy / H,
                             (pw / upscale) / W, (ph / upscale) / H, rot))
                    if rot:
                        os.remove(target)
                os.remove(crop)

        print("  pass %d (%dx%d, x%d, %s): %d found, %d new"
              % (pass_no + 1, nx, ny, upscale, threshold or "no threshold",
                 len(hits), len(hits) - before))

    out = {}
    for ref, records in hits.items():
        out[ref] = consensus(records)

    flag_collisions(out)

    path = os.path.join(build, "ocr_%s.json" % space)
    with open(path, "w") as f:
        json.dump({"space": space, "width": W, "height": H, "hits": out}, f, indent=1)

    missing = sorted(known - set(out), key=sort_key)
    tiers = {}
    for rec in out.values():
        tiers[rec["confidence"]] = tiers.get(rec["confidence"], 0) + 1

    print("%s/%s: %d of %d designators located (%.0f%%)"
          % (asm, space, len(out), len(known), 100.0 * len(out) / len(known)))
    for tier in ("agreed", "single", "ambiguous", "collision"):
        if tiers.get(tier):
            print("  %-10s %3d" % (tier, tiers[tier]))
    review = sorted([r for r, v in out.items()
                     if v["confidence"] in ("ambiguous", "collision", "single")],
                    key=sort_key)
    print("wrote %s" % os.path.relpath(path, ROOT))
    if review:
        print("needs review (%d): %s" % (len(review), " ".join(review)))
    if missing:
        print("not found (%d): %s" % (len(missing), " ".join(missing)))
    return out


def sort_key(ref):
    return (re.sub(r"\d", "", ref), int(re.sub(r"\D", "", ref) or 0))


# Two reads of the same label land within about a character's width of each
# other; anything further apart is a different piece of text.
CLUSTER_RADIUS = 0.008


def consensus(records):
    """
    Reduce one designator's hits to a position plus a confidence tier.

    agreed     several passes independently found it in the same place
    single     only one pass found it at all
    ambiguous  passes disagree about where it is, so one of them read
               a neighbouring label as this designator
    """
    clusters = []
    for rec in sorted(records, key=lambda r: -r[0]):
        for cluster in clusters:
            if abs(rec[1] - cluster[0][1]) < CLUSTER_RADIUS \
                    and abs(rec[2] - cluster[0][2]) < CLUSTER_RADIUS:
                cluster.append(rec)
                break
        else:
            clusters.append([rec])

    clusters.sort(key=len, reverse=True)
    best = clusters[0]
    total = len(records)

    if total == 1:
        confidence = "single"
    elif len(clusters) == 1 or len(best) >= max(2, total * 0.6):
        confidence = "agreed"
    else:
        confidence = "ambiguous"

    weight = sum(r[0] for r in best) or 1
    out = {
        "x": round(sum(r[0] * r[1] for r in best) / weight, 5),
        "y": round(sum(r[0] * r[2] for r in best) / weight, 5),
        "w": round(max(max(r[3] for r in best), 0.006), 5),
        "h": round(max(max(r[4] for r in best), 0.006), 5),
        "conf": round(max(r[0] for r in best), 1),
        "votes": len(best),
        "reads": total,
        "confidence": confidence,
    }
    # Every other cluster is kept, not just when the passes disagreed. A second
    # cluster is not always doubt: a designator can genuinely be written twice
    # on a sheet, and a test point always is -- once in the legend table that
    # names its signal, once on the net where you actually put a probe. Which
    # of those a reader wants is not something this pass can decide, so it
    # reports both and lets build_coords choose.
    if len(clusters) > 1:
        out["alternates"] = [{"x": round(c[0][1], 5), "y": round(c[0][2], 5),
                              "w": round(max(max(r[3] for r in c), 0.006), 5),
                              "h": round(max(max(r[4] for r in c), 0.006), 5),
                              "conf": round(max(r[0] for r in c), 1),
                              "votes": len(c)} for c in clusters[1:6]]
    return out


def flag_collisions(hits):
    """Two designators claiming the same spot means at least one is wrong."""
    refs = list(hits)
    for i, a in enumerate(refs):
        for b in refs[i + 1:]:
            if abs(hits[a]["x"] - hits[b]["x"]) < CLUSTER_RADIUS / 2 \
                    and abs(hits[a]["y"] - hits[b]["y"]) < CLUSTER_RADIUS / 2:
                for ref in (a, b):
                    hits[ref]["confidence"] = "collision"
                    hits[ref]["collidesWith"] = b if ref == a else a


if __name__ == "__main__":
    collect(sys.argv[1] if len(sys.argv) > 1 else "a18",
            sys.argv[2] if len(sys.argv) > 2 else "board")
