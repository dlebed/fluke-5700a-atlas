"""
spaces.py — the drawing and the schematic sheets, by name.

Everything downstream of extract_assets.sh works in one of two kinds of image
space: `board`, the component locator drawing, and `sh1`, `sh2`, ... one per
schematic sheet. The number of sheets is a property of the assembly, not of the
pipeline: A17 and A18 have two, A14 has four, A11 has six. Nothing should have
to be edited to take another one.

So the sheet count is read off the assets that extract_assets.sh actually
produced rather than declared in a table that then has to be kept in step.
"""

import os
import re

SHEET_RE = re.compile(r"^sh(\d+)$")


def image_for(space):
    """The full-resolution image behind a space: board -> drawing, shN -> schN."""
    if space == "board":
        return "drawing_full.png"
    m = SHEET_RE.match(space or "")
    return "sch%s_full.png" % m.group(1) if m else None


def image_path(build_dir, space):
    """Absolute path, or None if the space is not a space at all."""
    name = image_for(space)
    return os.path.join(build_dir, name) if name else None


def sheet_spaces(build_dir):
    """
    sh1 … shN for the sheets this assembly has, in order.

    A sheet counts if either its full-resolution crop or its reader output is
    present. Going by the crop alone was a quiet trap: the crops are build
    intermediates and are not versioned, while the reader output is, so on any
    fresh checkout this returned nothing and build_coords.py wrote a coords file
    with every schematic placement missing -- 239 of them on A13 -- without a
    word. Nothing downstream noticed, because an assembly legitimately may have
    no sheets placed yet.
    """
    out, n = [], 1
    while (os.path.exists(os.path.join(build_dir, "sch%d_full.png" % n)) or
           os.path.exists(os.path.join(build_dir, "ocr_sh%d.json" % n))):
        out.append("sh%d" % n)
        n += 1
    return out


def all_spaces(build_dir):
    return ["board"] + sheet_spaces(build_dir)


def require(build_dir, space):
    """Resolve a space to an existing image, or exit saying what is missing."""
    import sys
    path = image_path(build_dir, space)
    if not path:
        sys.exit("'%s' is not a space -- use 'board' or 'sh1', 'sh2', ..." % space)
    if not os.path.exists(path):
        have = ", ".join(all_spaces(build_dir)) or "nothing"
        sys.exit("no %s -- run tools/extract_assets.sh first (this assembly has: %s)"
                 % (os.path.basename(path), have))
    return path
