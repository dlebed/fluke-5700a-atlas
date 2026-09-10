#!/usr/bin/env python3
"""
detect_part_bodies.py — find the outline a part is drawn as, and propose its
marker geometry.

PROTOTYPE / authoring aid. This does not run as part of the build: the
full-resolution drawing it reads is a build intermediate and is not versioned,
so nothing in data/ may depend on it. It writes a proposal you paste into
data/<asm>.coords.overrides.json after looking at the pictures.

How it works
------------
The locator art letters a designator *inside* the part it names. So the reader
has already handed us a seed point inside the outline: the label box. From that
seed we cast rays outward, take the first ink each ray meets, and fit a shape to
the hits. Rays that hit something else -- a lead, a neighbouring part, the
lettering itself -- are outliers and are trimmed. A part whose surviving rays do
not agree on a shape is reported as "no confident fit" rather than guessed at,
because a marker in the wrong place is worse than a marker of the wrong shape.

Two shapes are fitted to the same hits and the better-supported one wins:

  circle   hits at a constant radius        -- cans, radial fuses, TO cans
  rect     hits on four straight lines      -- bridges, diodes, relays, DIPs

They are told apart by how well each explains the same evidence, so a fit is
only claimed when one hypothesis clearly beats the other and clears the
agreement floor on its own. Everything else is declined.

Three details of the artwork the fitter has to know about:

  * The lettering has to go before the rays are cast, or the rays stop on it.
    It is erased by connected component: ink components that lie wholly inside
    a box around the designator and are small enough to be a glyph are removed.
    An outline crossing that box is a large component and survives. Blanking a
    rectangle instead was tried first and is worse -- the label box is padded
    and sometimes wider than the part, so it blanks the very edge being looked
    for (CR3's left edge is 35 px from its label centre, inside a 52 px blank).

  * A diode or bridge is drawn with a solid polarity band across one end. A ray
    into it stops on the band's inner edge, several tens of pixels short of the
    outline, and the marker comes out short and off-centre. So a first hit that
    is *thicker than an outline stroke can be at that incidence* is treated as
    a filled region rather than an edge: the ray steps over it and takes the
    next stroke behind, if one is close enough to be the same part's edge.

  * Parts that touch let a ray through the tangent point and on into the
    neighbour, which is how F3/F5/F7 escaped: a ray leaving one fuse crossed
    the next one entirely and stopped on its far side, at r=239 where the truth
    is 86. Each hypothesis therefore bounds its own search: rays are re-cast
    with a ceiling set from the current estimate, so a ray that would have to
    run 1.7x further than its neighbours to find ink finds nothing instead.

Which parts to try comes from the parts list, which says what a part *is*
without saying anything about where it is: CAP,AL and CAP,TA are cans,
FUSE,...RADIAL is a cylinder, DIODE,...,BRIDGE and RELAY and IC,...DIP are
boxes. That classification is free and exact; it is the geometry that has to be
measured. --all ignores the list and tries everything with a placement, which
is how the reach of the method was measured rather than assumed.

    tools/detect_round_parts.py a18
    tools/detect_round_parts.py a18 --refs CR3 CR7 --debug
    tools/detect_round_parts.py a18 --all --by-family
"""

import argparse
import json
import math
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

WINDOW = 1000          # px of drawing cropped around a label
INK = 150              # 8-bit grey at or below this counts as a line
RAYS = 360
MIN_R = 40             # px; smaller than this is not a body on these drawings
MIN_SIDE = 60          # px; the shorter side a rectangular body must reach
MAX_ASPECT = 9.0       # a body longer than this against its width is a lead
TRIM = 0.30            # fraction of rays discarded as outliers each pass
MIN_INLIERS = 0.62     # accept only if this share of rays land on the outline
MARGIN = 0.06          # ... and only if it beats the other shape by this much
MIN_DRAWN = 0.62       # share of each of a rectangle's four sides that is ink
TOL = 0.045            # a hit counts as on-outline within this share of its
TOL_FLOOR = 7.0        # expected distance, but never less than this in px

# An outline stroke on these scans measures 5-8 px across. Ink thicker than
# this -- measured along the ray, so the threshold is relaxed for a glancing
# crossing -- is a filled region, not an edge.
STROKE = 11.0
BAND_GAP = 34.0        # px of white a stepped-over band may be followed by

# How far past its neighbours a ray may run before it is treated as having
# escaped through a gap rather than found this part's edge.
ESCAPE = 1.9
LOCAL = 12             # rays either side that "its neighbours" means

# Lettering is short strokes; an outline is a long one. 60 px sits between the
# longest stroke in a designator on these drawings (about 50, a rotated "1")
# and the shortest run an outline puts through a label box (64, the flat of the
# smallest fuse circle; a rectangle's edge runs its whole side).
RUN_KEEP = 60
LABEL_CAP = 240        # px; the most a read designator's box can be
SEED_CAP = 150         # ... and the most of a hand-placed box to trust as one

# How far off-centre the seed may sit inside the body it is supposed to be
# lettered inside, as a share of the half-width in that direction.
#
# This is the containment test, and it is the one thing standing between the
# method and a confident fit on the wrong part. It is not a tuned constant: a
# designator of height t centred at distance d inside a body of half-extent R
# only fits if d + t/2 <= R, so d/R <= 1 - t/2R. The lettering on these
# drawings runs 70-110 px inside bodies 170-190 px across, which puts the
# ceiling at 0.70-0.75. Anything past that is a label printed *beside* its
# part, not inside it, and the outline the rays found belongs to a neighbour.
#
# Measured on A18's fuse row, which is the case that matters: F3/F5/F7 seed at
# 0.54-0.59 and are right; F1, whose designator is printed clear of the can,
# seeds at 0.82 and fits a circle it does not name. At 0.90 -- where this
# started -- F1 is accepted and lands on the wrong fuse.
SEED_INSIDE = 0.70

# A rectangle needs a looser one, and not as a concession: on a round body the
# lettering has to sit near the centre because the radius is the same in every
# direction, but on a long thin body it is set rotated along the length and
# pushed against one of the long edges, where there is room for it. A18's
# bridges seed at up to 0.76 of the half-width across the short axis and are
# all correct -- CR7, CR11, CR15 and CR17 were checked on the drawing -- so
# holding a rectangle to the circle's figure throws away good fits. The
# containment test still does its job here; it is only measured per axis.
SEED_INSIDE_RECT = 0.90


# What the parts list calls a part, and what that says about how it is drawn.
# Order matters: the first fragment a description starts with wins. This is a
# candidate list, not a claim -- every entry still has to be measured, and
# families that turned out not to enclose their designator are marked so.
FAMILIES = [
    ("CAP,AL,",         "can"),
    ("CAP,TA,",         "can"),
    ("FUSE,",           "fuse"),
    ("DIODE,",          "diode"),
    ("THYRISTOR",       "diode"),
    ("ZENER",           "zener"),
    ("RELAY,",          "relay"),
    ("IC,",             "ic"),
    ("IC ",             "ic"),
    ("RES,CERM,SIP",    "sip"),
    ("CONN,",           "connector"),
    ("HEADER,",         "connector"),
    # A test point is a wire jumper: a bar with no body, and its marker is the
    # pad rather than an outline. Kept apart from the real connectors.
    ("JUMPER,WIRE",     "jumper"),
    ("JUMPER,",         "connector"),
    ("TRANSFORMER",     "transformer"),
    ("CHOKE",           "choke"),
    ("SWITCH,",         "switch"),
    ("THERMISTOR",      "thermistor"),
    ("HEAT DIS",        "heatsink"),
    ("TRANSISTOR",      "transistor"),
    ("PNP,",            "transistor"),
    ("NPN,",            "transistor"),
    ("RES,",            "resistor"),
    ("RESISTOR",        "resistor"),
    ("CAP,",            "cap-box"),
]

# Hardware that is not a component outline at all: screws, washers, feet,
# ejectors. They have parts-list rows and no body to fit.
SKIP_FAMILIES = ("SCREW,", "NUT,", "WASHER,", "RIVET,", "FOOT,", "EJECTOR,",
                 "INSUL ", "CABLE ", "SHIELD")


def family_of(desc):
    for frag in SKIP_FAMILIES:
        if desc.startswith(frag):
            return None
    for frag, name in FAMILIES:
        if desc.startswith(frag):
            return name
    return "other"


def run(cmd):
    r = subprocess.run(cmd, capture_output=True)
    if r.returncode != 0:
        sys.exit(" ".join(cmd[:4]) + "\n" + r.stderr.decode()[:400])
    return r.stdout


def size_of(path):
    out = run(["magick", "identify", "-format", "%w %h", path]).split()
    return int(out[0]), int(out[1])


def crop_grey(path, x0, y0, w, h):
    """A window of the drawing as (bytes, w, h) of 8-bit grey."""
    raw = run(["magick", path, "-crop", "%dx%d+%d+%d" % (w, h, x0, y0), "+repage",
               "-colorspace", "Gray", "-depth", "8", "pgm:-"])
    # P5\n<w> <h>\n255\n<data>, with comment lines possible.
    parts, i = [], 0
    while len(parts) < 4:
        j = raw.index(b"\n", i)
        line = raw[i:j]
        i = j + 1
        if line.startswith(b"#"):
            continue
        parts += line.split()
    gw, gh = int(parts[1]), int(parts[2])
    return bytearray(raw[i:i + gw * gh]), gw, gh


# --- getting the lettering out of the way -----------------------------------

def erase_label(grey, gw, gh, box):
    """
    Remove the designator's own strokes from the window, so the rays do not
    stop on them.

    Ink inside `box` is erased unless it lies on a run -- horizontal or
    vertical -- longer than a letter can be. That one test does the whole job,
    and does it without needing the box to be accurate:

      * A label box padded wider than the part is safe. CR3's left edge is
        35 px from its label centre, inside the box, but that stroke runs the
        full 383 px height of the part, so it stays while the lettering goes.
      * Lettering that touches the outline is still removed. CR15's "1" runs
        into the left edge of the part; by component they are one object and
        neither can be erased without the other, but by run length the 36 px
        bar is lettering and the 448 px stroke it touches is not.
      * A polarity band is a long run across the part and stays, which is what
        lets the caster recognise it as a band rather than an edge.

    Blanking the box outright was the first approach and is worse: it hides
    whichever edge happens to fall inside the box, which for a rotated
    designator beside a tall part is a common case rather than a rare one.
    """
    rx0 = max(1, int(box[0])); ry0 = max(1, int(box[1]))
    rx1 = min(gw - 2, int(box[2])); ry1 = min(gh - 2, int(box[3]))
    keep = set()
    # Horizontal runs, measured across the whole window rather than the box, so
    # a stroke is not cut short by where the box happens to end.
    for y in range(ry0, ry1 + 1):
        x = rx0
        base = y * gw
        while x <= rx1:
            if grey[base + x] > INK:
                x += 1
                continue
            a = x
            while a > 0 and grey[base + a - 1] <= INK:
                a -= 1
            b = x
            while b < gw - 1 and grey[base + b + 1] <= INK:
                b += 1
            if b - a + 1 >= RUN_KEEP:
                for k in range(max(a, rx0), min(b, rx1) + 1):
                    keep.add(base + k)
            x = b + 1
    for x in range(rx0, rx1 + 1):
        y = ry0
        while y <= ry1:
            if grey[y * gw + x] > INK:
                y += 1
                continue
            a = y
            while a > 0 and grey[(a - 1) * gw + x] <= INK:
                a -= 1
            b = y
            while b < gh - 1 and grey[(b + 1) * gw + x] <= INK:
                b += 1
            if b - a + 1 >= RUN_KEEP:
                for k in range(max(a, ry0), min(b, ry1) + 1):
                    keep.add(k * gw + x)
            y = b + 1
    erased = 0
    for y in range(ry0, ry1 + 1):
        base = y * gw
        for x in range(rx0, rx1 + 1):
            p = base + x
            if grey[p] <= INK and p not in keep:
                grey[p] = 255
                erased += 1
    return erased


# --- casting ----------------------------------------------------------------

def cast(grey, gw, gh, cx, cy, rmax_of):
    """
    First outline each ray meets, walking out from (cx, cy).

    `rmax_of(k, dx, dy)` gives the ceiling for ray k, which is how each
    hypothesis stops a ray escaping through a gap into the next part.

    Returns a list of RAYS entries, each (x, y, distance) or None.
    """
    out = []
    for k in range(RAYS):
        th = 2 * math.pi * k / RAYS
        dx, dy = math.cos(th), math.sin(th)
        rmax = rmax_of(k, dx, dy)
        # A stroke crossed at a glancing angle reads long along the ray, so the
        # "this is a filled band" threshold has to be relaxed by the incidence.
        lean = max(abs(dx), abs(dy))
        thick = STROKE / lean
        gap = BAND_GAP / lean
        hit = None
        step = 6
        limit = int(min(rmax, gw, gh))
        while step < limit:
            x = int(cx + dx * step)
            y = int(cy + dy * step)
            if x < 1 or y < 1 or x >= gw - 1 or y >= gh - 1:
                break
            if grey[y * gw + x] <= INK:
                first = step
                # Walk to the far side of this run of ink.
                end = step
                while end < limit:
                    x2 = int(cx + dx * end)
                    y2 = int(cy + dy * end)
                    if x2 < 1 or y2 < 1 or x2 >= gw - 1 or y2 >= gh - 1:
                        break
                    if grey[y2 * gw + x2] > INK:
                        break
                    end += 1
                if end - first <= thick:
                    hit = first                      # an outline stroke
                    break
                # A filled band: the outline is behind it, if it is close.
                probe = end
                found = None
                while probe < min(limit, end + gap):
                    x2 = int(cx + dx * probe)
                    y2 = int(cy + dy * probe)
                    if x2 < 1 or y2 < 1 or x2 >= gw - 1 or y2 >= gh - 1:
                        break
                    if grey[y2 * gw + x2] <= INK:
                        found = probe
                        break
                    probe += 1
                # Nothing behind it: this was not a band inside the part but a
                # thick edge -- two parts that touch share a doubled boundary
                # about as thick as a polarity band. Stopping on its near side
                # keeps the box out of the neighbour, which is the error worth
                # avoiding; CR8 and CR10 touch and each would otherwise claim
                # 14 px of the other.
                hit = found if found is not None else first
                break
            step += 1
        if hit is None or hit >= limit:
            out.append(None)
        else:
            out.append((cx + dx * hit, cy + dy * hit, float(hit)))
    return out


def unbounded(_k, _dx, _dy):
    return WINDOW / 2.0 - 4


def trim_escapes(hits):
    """
    Drop rays that ran far past their neighbours.

    A ray that crosses a tangent point between two touching parts runs on
    through the neighbour and stops on its far side. Comparing each ray with
    the rays either side of it -- rather than with a single radius -- rejects
    those without also rejecting the long rays a rectangle legitimately has at
    its corners.
    """
    out = list(hits)
    for k, h in enumerate(hits):
        if h is None:
            continue
        near = [hits[(k + j) % RAYS][2] for j in range(-LOCAL, LOCAL + 1)
                if hits[(k + j) % RAYS]]
        if len(near) < 5:
            continue
        near.sort()
        med = near[len(near) // 2]
        if h[2] > ESCAPE * med:
            out[k] = None
    return out


def median(values):
    v = sorted(values)
    return v[len(v) // 2] if v else None


# --- circle -----------------------------------------------------------------

def fit_circle(points):
    """Kasa algebraic circle fit. Returns (cx, cy, r) or None."""
    n = len(points)
    if n < 8:
        return None
    sx = sy = sxx = syy = sxy = sxz = syz = sz = 0.0
    for x, y in points:
        z = x * x + y * y
        sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y
        sxz += x * z; syz += y * z; sz += z
    # Solve the 3x3 normal equations for (A,B,C) in x^2+y^2 = A x + B y + C.
    m = [[sxx, sxy, sx, sxz],
         [sxy, syy, sy, syz],
         [sx,  sy,  float(n), sz]]
    for col in range(3):
        piv = max(range(col, 3), key=lambda r: abs(m[r][col]))
        if abs(m[piv][col]) < 1e-9:
            return None
        m[col], m[piv] = m[piv], m[col]
        for r in range(3):
            if r == col:
                continue
            f = m[r][col] / m[col][col]
            for c in range(col, 4):
                m[r][c] -= f * m[col][c]
    a, b, c = (m[i][3] / m[i][i] for i in range(3))
    cx, cy = a / 2, b / 2
    disc = c + cx * cx + cy * cy
    if disc <= 0:
        return None
    return cx, cy, math.sqrt(disc)


def refine_circle(grey, gw, gh, cx, cy, hits):
    """Iterate a circle fit, each pass bounding its own rays."""
    live = [h for h in hits if h]
    if len(live) < RAYS * 0.4:
        return None
    r = median([h[2] for h in live])
    circle = None
    for _ in range(4):
        bound = ESCAPE * r
        cast_hits = cast(grey, gw, gh, cx, cy, lambda k, dx, dy: bound)
        live = [h for h in cast_hits if h]
        if len(live) < RAYS * 0.4:
            return None
        # Trim the rays that ran furthest and least far before fitting: those
        # are the ones that stopped on a lead crossing the interior, or found
        # the edge late.
        radii = sorted(h[2] for h in live)
        lo = radii[int(len(radii) * TRIM / 2)]
        hi = radii[int(len(radii) * (1 - TRIM / 2)) - 1]
        pts = [(h[0], h[1]) for h in live if lo <= h[2] <= hi]
        circle = fit_circle(pts)
        if not circle:
            return None
        cx, cy, r = circle
        if r < MIN_R or r > WINDOW / 2:
            return None
    return circle


# --- rectangle --------------------------------------------------------------

def exit_face(cx, cy, edges, dx, dy):
    """Which side of the rectangle a ray leaves by, under the current estimate."""
    tx = ty = float("inf")
    if dx > 1e-9:
        tx = (edges["R"] - cx) / dx
    elif dx < -1e-9:
        tx = (edges["L"] - cx) / dx
    if dy > 1e-9:
        ty = (edges["B"] - cy) / dy
    elif dy < -1e-9:
        ty = (edges["T"] - cy) / dy
    if tx <= ty:
        return "R" if dx > 0 else "L"
    return "B" if dy > 0 else "T"


def rect_edges(cx, cy, hits, edges):
    """
    Re-estimate (left, right, top, bottom) from the hits.

    A hit is assigned to the side its own ray leaves by, not to whichever side
    it happens to lie nearest. On a part three times taller than it is wide the
    two differ constantly: a ray leaving through the top of CR11 lands 55 px
    from the left edge and 76 px from the top one, and assigning it by
    proximity gives the top edge six supporting rays out of the forty-five that
    are really its own. Taking the median per side rather than a mean keeps one
    stray ray from dragging a whole edge.
    """
    buckets = {"L": [], "R": [], "T": [], "B": []}
    for k, h in enumerate(hits):
        if not h:
            continue
        th = 2 * math.pi * k / RAYS
        side = exit_face(cx, cy, edges, math.cos(th), math.sin(th))
        buckets[side].append(h[0] if side in "LR" else h[1])
    out = dict(edges)
    for side, vals in buckets.items():
        if len(vals) >= 6:
            out[side] = median(vals)
    return out, {s: len(v) for s, v in buckets.items()}


def rect_distance(cx, cy, edges, dx, dy):
    """How far from (cx, cy) the rectangle's outline is along (dx, dy)."""
    best = float("inf")
    if dx > 1e-9:
        best = min(best, (edges["R"] - cx) / dx)
    elif dx < -1e-9:
        best = min(best, (edges["L"] - cx) / dx)
    if dy > 1e-9:
        best = min(best, (edges["B"] - cy) / dy)
    elif dy < -1e-9:
        best = min(best, (edges["T"] - cy) / dy)
    return best


def edge_coverage(grey, gw, gh, edges, reach=6, samples=40):
    """
    How much of each of the four sides is actually drawn, worst side first.

    Ray agreement says the hits lie where the rectangle says they should. It
    does not say the rectangle is there: A18's axial diodes are drawn as a
    symbol on a pair of long leads, and a box fitted between two neighbouring
    parts' leads agrees with two thirds of the rays while enclosing nothing.
    Its left and right sides are fully inked -- they are the leads -- and its
    top and bottom are empty air. A part's outline is drawn on all four.
    """
    out = {}
    for side in ("L", "R", "T", "B"):
        vertical = side in "LR"
        a = edges["T"] if vertical else edges["L"]
        b = edges["B"] if vertical else edges["R"]
        fixed = int(edges[side])
        span = b - a
        if span <= 0:
            return {side: 0.0}
        on = 0
        for i in range(samples):
            t = a + span * (0.03 + 0.94 * i / (samples - 1.0))
            found = False
            for d in range(-reach, reach + 1):
                x = fixed + d if vertical else int(t)
                y = int(t) if vertical else fixed + d
                if 0 <= x < gw and 0 <= y < gh and grey[y * gw + x] <= INK:
                    found = True
                    break
            on += found
        out[side] = on / float(samples)
    return out


def refine_rect(grey, gw, gh, cx, cy, hits):
    """Iterate an axis-aligned rectangle fit, each pass bounding its own rays."""
    live = [h for h in hits if h]
    if len(live) < RAYS * 0.4:
        return None
    # Start from the extent of the hits, which needs no prior estimate and is
    # exact for a rectangle: every hit lies on it, so the furthest hit in each
    # direction is that side. Read at the 2nd percentile rather than the very
    # extreme so a single stray ray cannot set an edge.
    xs = sorted(h[0] for h in live)
    ys = sorted(h[1] for h in live)
    lo, hi = int(len(xs) * 0.02), int(len(xs) * 0.98)
    edges = {"L": xs[lo], "R": xs[hi], "T": ys[lo], "B": ys[hi]}
    support = None
    for _ in range(4):
        cx = (edges["L"] + edges["R"]) / 2.0
        cy = (edges["T"] + edges["B"]) / 2.0
        here = edges

        def bound(_k, dx, dy, e=here, ex=cx, ey=cy):
            return ESCAPE * rect_distance(ex, ey, e, dx, dy)

        cast_hits = cast(grey, gw, gh, cx, cy, bound)
        edges, support = rect_edges(cx, cy, cast_hits, edges)
        w = edges["R"] - edges["L"]
        h = edges["B"] - edges["T"]
        if w < MIN_SIDE or h < MIN_SIDE or w > WINDOW * 0.95 or h > WINDOW * 0.95:
            return None
    if min(support.values()) < 10:
        return None
    w = edges["R"] - edges["L"]
    h = edges["B"] - edges["T"]
    if max(w, h) / min(w, h) > MAX_ASPECT:
        return None
    return edges


# --- scoring ----------------------------------------------------------------

def agreement(hits, expected):
    """
    Share of all rays whose unbounded first hit lands on the proposed outline.

    Scored against the rays as cast with no ceiling, so a fit cannot buy its
    own agreement with the bound that produced it.
    """
    on = 0
    for k, h in enumerate(hits):
        if not h:
            continue
        th = 2 * math.pi * k / RAYS
        want = expected(math.cos(th), math.sin(th))
        if want <= 0 or math.isinf(want):
            continue
        if abs(h[2] - want) <= max(TOL * want, TOL_FLOOR):
            on += 1
    return on / float(RAYS)


def detect(src, W, H, seed, label, read, debug=False):
    """
    seed/label are placements in normalised board space: where to cast from and
    which lettering to erase. `read` says the label came from the reader, so it
    really is the lettering; a hand-placed box may already be a body box, and
    only as much of one as a designator could fill is treated as lettering.
    Returns a proposal dict, or None.
    """
    lx, ly = seed["x"] * W, seed["y"] * H
    x0 = max(0, min(W - WINDOW, int(lx - WINDOW / 2)))
    y0 = max(0, min(H - WINDOW, int(ly - WINDOW / 2)))
    grey, gw, gh = crop_grey(src, x0, y0, WINDOW, WINDOW)

    cx, cy = lx - x0, ly - y0
    bx, by = label["x"] * W - x0, label["y"] * H - y0
    cap = LABEL_CAP if read else SEED_CAP
    lw = min(label.get("w", 0.01) * W, cap)
    lh = min(label.get("h", 0.01) * H, cap)
    erase_label(grey, gw, gh, (bx - lw / 2, by - lh / 2, bx + lw / 2, by + lh / 2))

    raw = trim_escapes(cast(grey, gw, gh, cx, cy, unbounded))

    circle = refine_circle(grey, gw, gh, cx, cy, raw)
    rect = refine_rect(grey, gw, gh, cx, cy, raw)

    # A fit has to contain the seed it grew from. The whole method rests on the
    # designator being lettered inside the part, so a body that does not cover
    # the lettering is a body the rays wandered off to -- a neighbour, or the
    # gap between two parts. This is what declines F201's fuse, whose label is
    # printed clear of the can, without having to know that in advance.
    options = []
    if circle:
        ccx, ccy, r = circle
        if math.hypot(cx - ccx, cy - ccy) <= SEED_INSIDE * r:
            final = cast(grey, gw, gh, ccx, ccy, unbounded)
            options.append(("circle", agreement(final, lambda dx, dy: r), {
                "x": int(round(ccx + x0)), "y": int(round(ccy + y0)),
                "w": int(round(2 * r)), "h": int(round(2 * r)),
            }, ccx, ccy, 2 * r))
    if rect:
        rcx = (rect["L"] + rect["R"]) / 2.0
        rcy = (rect["T"] + rect["B"]) / 2.0
        inset_x = (1 - SEED_INSIDE_RECT) * (rect["R"] - rect["L"]) / 2.0
        inset_y = (1 - SEED_INSIDE_RECT) * (rect["B"] - rect["T"]) / 2.0
        sides = edge_coverage(grey, gw, gh, rect)
        drawn = min(sides.values())
        if debug:
            print("      rect sides drawn " +
                  " ".join("%s %.2f" % (s, sides[s]) for s in "LRTB"))
        if drawn >= MIN_DRAWN and \
           rect["L"] + inset_x <= cx <= rect["R"] - inset_x and \
           rect["T"] + inset_y <= cy <= rect["B"] - inset_y:
            final = cast(grey, gw, gh, rcx, rcy, unbounded)
            options.append(("rect", agreement(
                final, lambda dx, dy: rect_distance(rcx, rcy, rect, dx, dy)), {
                "x": int(round(rcx + x0)), "y": int(round(rcy + y0)),
                "w": int(round(rect["R"] - rect["L"])),
                "h": int(round(rect["B"] - rect["T"])),
            }, rcx, rcy, min(rect["R"] - rect["L"], rect["B"] - rect["T"])))

    scores = {name: score for name, score, _, _, _, _ in options}
    if debug:
        print("      " + ("  ".join("%s %.2f" % kv for kv in sorted(scores.items()))
                          or "nothing fitted"))
    if not options:
        return None
    options.sort(key=lambda o: -o[1])
    name, score, px, fcx, fcy, span = options[0]
    runner = options[1][1] if len(options) > 1 else 0.0
    if score < MIN_INLIERS:
        return None
    if score - runner < MARGIN:
        # Both hypotheses explain the same hits about as well, which means the
        # evidence does not say which the part is. Declined rather than picked.
        return {"ambiguous": True, "scores": scores}
    return {
        "shape": name,
        "score": round(score, 3),
        "runnerUp": round(runner, 3),
        "px": px,
        # How far the marker's anchor moves when the label box is replaced by
        # the body, as a share of the body's shorter side: well under 0.5 means
        # the marker is still over the same part.
        "drift": math.hypot(fcx - cx, fcy - cy) / span,
    }


# --- driving ----------------------------------------------------------------

def candidates(asm, refs, want_all, families):
    """Parts with a board placement that are worth measuring a body for."""
    extracted = json.load(open(os.path.join(ROOT, ".build", asm, "extracted.json")))
    coords = json.load(open(os.path.join(ROOT, "data", "%s.coords.json" % asm)))
    ocr = json.load(open(os.path.join(ROOT, ".build", asm, "ocr_board.json")))
    placed = coords["placement"]
    out = []
    for c in extracted["components"]:
        ref = c.get("ref")
        desc = (c.get("desc") or "").upper()
        fam = family_of(desc)
        if refs:
            if ref not in refs:
                continue
        elif families:
            if fam not in families:
                continue
        elif not want_all:
            if fam not in DEFAULT_FAMILIES:
                continue
        elif fam is None:
            continue
        board = (placed.get(ref) or {}).get("board")
        if not board:
            continue
        # The lettering to erase is the reader's own box where there is one --
        # padded the same way build_coords.py pads it, since the raw box hugs
        # the glyphs. Otherwise fall back to the placement, which for a
        # hand-placed part may be a body box rather than a label box.
        hit = ocr["hits"].get(ref)
        # ... and only if the reader put it where the placement is. A hand
        # placement usually exists precisely because the read was wrong:
        # C202's was read 1700 px away, on the other side of the board.
        if hit and math.hypot((hit["x"] - board["x"]) * ocr["width"],
                              (hit["y"] - board["y"]) * ocr["height"]) > 120:
            hit = None
        if hit:
            label = dict(hit, w=hit["w"] * 1.35, h=hit["h"] * 1.35)
        else:
            label = board
        out.append((ref, fam or "other", board, label, bool(hit)))
    out.sort(key=lambda t: (re.sub(r"\d", "", t[0]), int(re.sub(r"\D", "", t[0]) or 0)))
    return out


# Families whose parts are drawn as an outline with the designator inside, as
# measured on A18 and A14. Anything else has to be asked for with --families or
# --all, so the default run does not propose geometry for parts whose label is
# printed beside them.
DEFAULT_FAMILIES = ("can", "fuse", "diode", "relay", "ic", "sip",
                    "connector", "transformer", "switch", "heatsink")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("assembly")
    ap.add_argument("--refs", nargs="*")
    ap.add_argument("--families", nargs="*",
                    help="only these parts-list families")
    ap.add_argument("--all", action="store_true",
                    help="try every placed part, whatever the parts list says")
    ap.add_argument("--by-family", action="store_true",
                    help="summarise the hit rate per family")
    ap.add_argument("--debug", action="store_true")
    args = ap.parse_args()

    asm = args.assembly.lower()
    src = os.path.join(ROOT, ".build", asm, "drawing_full.png")
    if not os.path.exists(src):
        sys.exit("%s is a build intermediate and is not present; "
                 "run tools/extract_assets.sh %s first" % (src, asm))
    W, H = size_of(src)

    found, missed, ambiguous = {}, [], {}
    tally = {}
    for ref, fam, board, label, read in candidates(asm, args.refs, args.all, args.families):
        if args.debug:
            print("  %-6s %s" % (ref, fam))
        got = detect(src, W, H, board, label, read, args.debug)
        slot = tally.setdefault(fam, {"n": 0, "circle": 0, "rect": 0})
        slot["n"] += 1
        if got and got.get("shape"):
            found[ref] = got
            slot[got["shape"]] += 1
            print("  %-6s %-6s %4dx%-4d at %d,%d   agreement %.0f%% "
                  "(other shape %.0f%%)  drift %.2f"
                  % (ref, got["shape"], got["px"]["w"], got["px"]["h"],
                     got["px"]["x"], got["px"]["y"], got["score"] * 100,
                     got["runnerUp"] * 100, got["drift"]))
        elif got:
            ambiguous[ref] = got["scores"]
            print("  %-6s shape ambiguous (%s)" % (
                ref, ", ".join("%s %.0f%%" % (k, v * 100)
                               for k, v in sorted(got["scores"].items()))))
        else:
            missed.append(ref)
            print("  %-6s no confident fit" % ref)

    total = len(found) + len(missed) + len(ambiguous)
    print("\n%d of %d fitted (%d circle, %d rect)"
          % (len(found), total,
             sum(1 for g in found.values() if g["shape"] == "circle"),
             sum(1 for g in found.values() if g["shape"] == "rect")))
    if args.by_family or args.all:
        print("\n%-12s %5s %7s %6s %6s" % ("family", "tried", "fitted", "circle", "rect"))
        for fam in sorted(tally):
            t = tally[fam]
            hit = t["circle"] + t["rect"]
            print("  %-10s %5d %6d%%  %5d %6d"
                  % (fam, t["n"], round(100.0 * hit / t["n"]), t["circle"], t["rect"]))
    if missed:
        print("\nno fit: " + " ".join(missed))
    if ambiguous:
        print("ambiguous: " + " ".join(sorted(ambiguous)))

    out = {ref: dict(g["px"], shape=g["shape"]) for ref, g in sorted(found.items())}
    dest = os.path.join(ROOT, ".build", asm, "part_bodies.json")
    json.dump(out, open(dest, "w"), indent=1, sort_keys=True)
    print("\nproposal written to %s" % dest)
    print("render every entry before you accept it:")
    print("  .claude/skills/add-assembly/scripts/review_markers.py %s board --refs ..." % asm)
    print("then paste what survives into data/%s.coords.overrides.json under \"board\"" % asm)


if __name__ == "__main__":
    main()
