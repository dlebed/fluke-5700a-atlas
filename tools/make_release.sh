#!/usr/bin/env bash
#
# make_release.sh — build the standalone package a user actually runs.
#
# The repository carries the whole chain: the page, and the pipeline that turns
# service manual PDFs into the datasets behind it. Someone servicing a
# calibrator wants only the first half. This copies that half into a directory
# and zips it.
#
# Usage:   tools/make_release.sh [output-name]
#          tools/make_release.sh                  # -> dist/fluke-5700a-atlas{,.zip}
#
# The file list is derived, never hardcoded: whatever index.html loads, plus
# whatever image paths the datasets themselves name. Add a board, or a fifth
# schematic sheet, and this picks it up with no edit here. If a referenced file
# is missing the script stops rather than shipping a package with a hole in it.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
NAME="${1:-fluke-5700a-atlas}"
OUT="$ROOT/dist/$NAME"

cd "$ROOT"
rm -rf "$OUT" "$OUT.zip"
mkdir -p "$OUT"

say() { printf '  %s\n' "$*"; }

# ---- 1. the page, its styles and the engine ---------------------------------
#
# index.html names every script and stylesheet it needs, so read them off it
# rather than keeping a second list here that can drift.
missing=0
while read -r ref; do
  [ -z "$ref" ] && continue
  case "$ref" in http*|//*|data:*|'#'*) continue;; esac
  if [ ! -f "$ref" ]; then echo "MISSING, referenced by index.html: $ref" >&2; missing=1; continue; fi
  mkdir -p "$OUT/$(dirname "$ref")"
  cp "$ref" "$OUT/$ref"
done < <(grep -oE '(src|href)="[^"]+"' index.html | sed 's/.*="//;s/"//' | sort -u)
cp index.html "$OUT/"
say "page, styles and engine"

# ---- 2. the images the datasets ask for -------------------------------------
#
# assemble.py bakes the drawing, photo and schematic paths into data/<asm>.js,
# so the datasets are the authority on which images exist.
n=0
while read -r img; do
  [ -z "$img" ] && continue
  if [ ! -f "$img" ]; then echo "MISSING, referenced by a dataset: $img" >&2; missing=1; continue; fi
  mkdir -p "$OUT/$(dirname "$img")"
  cp "$img" "$OUT/$img"
  n=$((n + 1))
done < <(grep -ohE '"assets/[^"]+"' data/*.js | tr -d '"' | sort -u)
say "$n board images"

# The mark is used by the README, the favicon by the page; neither is named in
# a dataset.
mkdir -p "$OUT/assets/brand"
for f in favicon.svg mark.svg; do
  [ -f "assets/brand/$f" ] && cp "assets/brand/$f" "$OUT/assets/brand/$f"
done

# ---- 3. the documents that have to travel with it ---------------------------
#
# Not optional. The xDevs.com terms require the notice, the conditions and the
# link to /fix/f5700a/ to be reproduced "in the documentation and/or other
# materials provided with the distribution", and the safety warning is the
# reason anyone should read anything before opening a 5700A at all.
for doc in LICENSE CREDITS.md; do
  [ -f "$doc" ] || { echo "MISSING: $doc must ship with the package" >&2; exit 1; }
  cp "$doc" "$OUT/"
done

# A README written for the package rather than the repository: the full one
# documents a pipeline that is deliberately not in here. The safety section is
# lifted from it so there is one copy of that text in the project, and the
# script fails if the heading it anchors on has moved -- shipping this without
# the warning is not a thing to do quietly.
if ! grep -q '^## Safety and disclaimer' README.md; then
  echo "MISSING: '## Safety and disclaimer' not found in README.md" >&2; exit 1
fi
{
  printf '<img src="assets/brand/mark.svg" alt="" width="56" height="56" align="left">\n\n'
  printf '# Fluke 5700A Atlas\n\n'
  printf 'A bench tool for servicing the Fluke 5700A/5720A calibrator: find a part on\n'
  printf 'the board, see what a test point should read and what to reference it against,\n'
  printf "step through the manual's troubleshooting procedure, and record what you\n"
  printf 'measured so the readings are still there next year.\n\n'
  printf 'Standalone HTML: open `index.html` in a browser and it works. No server, no\n'
  printf 'build step, no install, no network. Everything you record stays in your own\n'
  printf "browser's local storage.\n\n"
  printf 'Author Mode — the greyed **Author** tab, top right — adds editing: move a\n'
  printf 'marker onto the part it actually labels, place one the reader missed, or\n'
  printf 'realign a photograph. Those edits apply in normal use too, and *Export\n'
  printf 'coordinates* hands them back for folding into the source data.\n\n'
  printf -- '---\n\n'
  sed -n '/^## Safety and disclaimer/,/^## What it does/p' README.md | sed '$d'
  printf -- '---\n\n'
  printf '## Licence and credits\n\n'
  printf 'The code is MIT licensed — see `LICENSE`.\n\n'
  printf 'The board drawings, schematic sheets, parts lists, procedures and fault codes\n'
  printf "are derived from Fluke's service manuals, and the board photographs are in the\n"
  printf 'main from xDevs.com. Both carry their own terms, set out in `CREDITS.md`,\n'
  printf 'which must travel with any redistribution of this package.\n\n'
  printf 'This is an independent project, not affiliated with or endorsed by Fluke\n'
  printf 'Corporation.\n\n'
  printf 'Source, including the extraction pipeline that builds the datasets:\n'
  printf 'https://github.com/dlebed/fluke-5700a-atlas\n'
} > "$OUT/README.md"
say "LICENSE, CREDITS.md and a package README"

[ "$missing" -eq 0 ] || { echo "refusing to package: files above are missing" >&2; exit 1; }

# ---- 4. check nothing from the workshop came along --------------------------
strays=$(find "$OUT" \( -name '*.py' -o -name '*.sh' -o -name '.build' -o -name 'tools' \
  -o -name '*.coords.json' -o -name '*.overrides.json' -o -name '*.testpoints.json' \
  -o -name '*.reference.json' -o -name '*.caps.json' -o -name '.git' -o -name '.claude' \
  -o -name 'test-logs' -o -name 'CLAUDE.md' -o -name '.DS_Store' \) -print)
if [ -n "$strays" ]; then echo "workshop files leaked into the package:" >&2; echo "$strays" >&2; exit 1; fi

# Every reference resolves inside the package, not just in the source tree.
( cd "$OUT"
  for ref in $(grep -oE '(src|href)="[^"]+"' index.html | sed 's/.*="//;s/"//' | sort -u); do
    case "$ref" in http*|//*|data:*|'#'*) continue;; esac
    [ -f "$ref" ] || { echo "broken in package: $ref" >&2; exit 1; }
  done
  for img in $(grep -ohE '"assets/[^"]+"' data/*.js | tr -d '"' | sort -u); do
    [ -f "$img" ] || { echo "broken in package: $img" >&2; exit 1; }
  done )
say "every reference resolves"

# ---- 5. zip it --------------------------------------------------------------
( cd "$ROOT/dist" && zip -r -q -X "$NAME.zip" "$NAME" -x '*/.*' )

printf '\n%s\n' "$NAME"
say "$(find "$OUT" -type f | wc -l | tr -d ' ') files, $(du -sh "$OUT" | cut -f1)"
say "dist/$NAME/"
say "dist/$NAME.zip ($(du -h "$OUT.zip" | cut -f1))"
