#!/usr/bin/env bash
#
# extract_assets.sh — build the image assets for one assembly.
#
# Source PDFs are 400 dpi scans stored with a 90-degree page rotation, so every
# page is extracted with pdfimages (lossless, no resampling), rotated upright,
# cropped to the region of interest, and only then downscaled for the browser.
#
# Usage:   tools/extract_assets.sh [assembly-id]
#          tools/extract_assets.sh          # defaults to a18
#
# Add a new assembly by appending a config block to the case statement below.
# Crop rectangles are in full-resolution pixels of the upright (rotated) page,
# measured once by eye against .claude/skills/add-assembly/scripts/page_grid.py.

set -euo pipefail

ASM="${1:-a18}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
DOCS="$(dirname "$ROOT")"

CH7="$DOCS/Schematics_and_Parts_Lists/5700A_Rev9_ServiceManual_Ch7_Schematic_Diagrams.pdf"

# Optional, per assembly: a WxH+X+Y rectangle in pixels of the source
# photograph. Empty means no crop, which is the default and what every board
# uses today -- see the photo step at the foot of this script for when a crop
# is and is not appropriate.
PHOTO_CROP=""

case "$ASM" in
  a18)
    DRAWING_PAGE=82
    DRAWING_CROP="5810x3420+325+372"      # PCB outline incl. ejectors and P901/P902
    SCHEMATIC_PAGES=(83 84)
    SCHEMATIC_CROPS=("6410x3860+60+240" "6410x3860+60+240")
    PHOTO_SRC="$DOCS/Photos/a18_top.jpg"
    ;;
  a19)
    DRAWING_PAGE=85
    DRAWING_CROP="6140x2155+170+995"      # PCB outline incl. ejectors and P41
    # One sheet only. Figure 7-24 (A20 CPU PCA) begins on page 87, so there is
    # no sheet 2 to look for -- 5700A-1004 prints no "(n of m)" at all.
    SCHEMATIC_PAGES=(86)
    # The outer border was measured off the ink profile rather than the first
    # ink from the left: the scan's own black page edge starts at x=6600 and is
    # darker than the frame. The frame's outer rules are at x=32 and x=6327,
    # y=258 and y=4097, with the zone-label band 60 px inside each of them.
    SCHEMATIC_CROPS=("6310x3855+25+250")
    PHOTO_SRC="$DOCS/Photos/a19_top.jpg"
    ;;
  a20)
    DRAWING_PAGE=87
    DRAWING_CROP="6120x2035+190+1040"     # PCB outline incl. ejectors and P61/P62
    # Five sheets, counted off the title blocks rather than assumed: 5700A-1006
    # prints "(1 of 5)" through "(5 of 5)" on pages 88-92, page 87 is the locator
    # (5700A-1606) and page 93 is already A21's locator (5700A-1609).
    SCHEMATIC_PAGES=(88 89 90 91 92)
    # Measured per sheet by eye against scripts/page_grid.py and four
    # full-resolution corner crops each, not by probing: an ink profile of these
    # five pages returns the dense bus columns and the scan's own black page edge
    # (x~6600 on every sheet) alongside the frame and cannot tell them apart.
    # No two sheets share a rectangle, and all five are scanned with a fraction
    # of a degree of skew that moves a border 25-40 px between the two ends of
    # the same line -- each rectangle takes the outer extreme of its skewed
    # border plus a few px, so no corner is clipped. On sheets 1, 3 and 5 the
    # frame's outer left border and its row-letter band are off the page in the
    # scan, as on A14, so x starts at 0 and nothing is lost; on sheets 2 and 4
    # that border is at x=25 and x=45.
    SCHEMATIC_CROPS=("6340x3880+0+238" "6375x3865+20+250" "6353x3881+0+248" \
                     "6378x3880+40+240" "6360x3886+0+245")
    PHOTO_SRC="$DOCS/Photos/a20_top.jpg"
    # PHOTO_CROP stays unset. The blue of the PCB does start 240 px below the top
    # of the 5727x2090 frame, but both ejector levers are photographed swung out
    # of their stowed position and stand well above it -- the left one's tip
    # reaches y=30, the right one's y=215. Measured to everything that is part of
    # the assembly the margins are 30 top, 55 bottom (the P61/P62 shells), 64 left
    # and 81 right, so the frame is already tight and a top crop would cut the
    # left lever off.
    ;;
  a4)
    DRAWING_PAGE=13
    # Confirmed by rendering the title band: page 13 is drawing 5700A-1605, a
    # 16xx and therefore a component locator, captioned "Figure 7-4. A4 Digital
    # Motherboard PCA" (manual page 7-15). Page 12 is A3's last schematic sheet
    # (5700A-1001, 4 of 4) and page 17 is already A5's locator (5700A-1611).
    DRAWING_CROP="5536x3500+97+283"       # PCB outline incl. P81/P82 and the fan/line cutouts
    # Three sheets, counted off the title blocks rather than assumed: 5700A-1005
    # prints "(1 of 3)", "(2 of 3)", "(3 of 3)" on pages 14-16.
    SCHEMATIC_PAGES=(14 15 16)
    # Measured per sheet against the outer rule of the D-sheet frame, every
    # corner read off scripts/page_grid.py at 1.5-2x rather than probed: the
    # scan's own black page edge sits at x=6597 on all three sheets and is
    # darker than the frame. No two sheets share a rectangle -- each is scanned
    # with a fraction of a degree of skew that moves a border 16-35 px between
    # the two ends of the same line, and the rectangles below take the outer
    # extreme of each skewed border plus a few px so no corner is clipped. On
    # sheet 1 the frame's left border and its row-letter band are off the page
    # entirely (the inner frame starts at x=31 and the band is ~62 px wide), as
    # on A14, so its x starts at 0 and nothing is lost.
    SCHEMATIC_CROPS=("6341x3874+0+215" "6381x3854+46+234" "6424x3900+1+204")
    PHOTO_SRC="$DOCS/Photos/a4_top.jpg"
    ;;
  a17)
    DRAWING_PAGE=79
    DRAWING_CROP="5340x3160+615+400"      # PCB outline incl. ejectors and P801/P802
    SCHEMATIC_PAGES=(80 81)
    # The two sheets were scanned at slightly different scale -- sheet 2's frame
    # is ~3% larger than sheet 1's -- so one shared rectangle either clips one
    # border or leaves a fat margin on the other. Measure and crop each sheet.
    SCHEMATIC_CROPS=("6196x3765+151+278" "6382x3870+17+252")
    PHOTO_SRC="$DOCS/Photos/a17_top.jpg"
    ;;
  a14)
    DRAWING_PAGE=65
    DRAWING_CROP="5897x3351+320+496"      # PCB outline incl. ejectors and P611/P612
    SCHEMATIC_PAGES=(66 67 68 69)
    # Unlike A17, these four were scanned at one scale and share a rectangle.
    # The left zone-label band is off the page on every sheet -- the scan is
    # cropped inside the frame's left border -- so x starts at 0 and the crop
    # loses nothing but that band. Sheet 4 is the relay state table rather than
    # a schematic; it is extracted for reading, not for placing components.
    SCHEMATIC_CROPS=("6345x3821+0+282" "6345x3821+0+282" "6345x3821+0+282" "6345x3821+0+282")
    PHOTO_SRC="$DOCS/Photos/a14_top.jpg"
    ;;
  a12)
    DRAWING_PAGE=55
    DRAWING_CROP="5265x3029+594+604"      # PCB outline incl. ejectors and P501/P502
    SCHEMATIC_PAGES=(56 57 58)
    # Sheet 1 was reproduced about 1% smaller than sheets 2 and 3, and all three
    # sit at slightly different offsets, so each gets its own rectangle measured
    # to its own outer border. On sheets 1 and 2 the frame's left border is off
    # the page (the inner frame starts at x=31 and the zone band is ~60 px wide),
    # so x starts at 0 and the crop loses only that already-clipped band; on
    # sheet 3 the same choice adds ~80 px of white and clips nothing.
    SCHEMATIC_CROPS=("6335x3832+0+260" "6408x3893+0+243" "6370x3878+0+240")
    PHOTO_SRC="$DOCS/Photos/a12_top.jpg"
    ;;
  a13)
    DRAWING_PAGE=59
    DRAWING_CROP="6020x3320+300+455"      # PCB outline incl. ejectors and P511/P512
    SCHEMATIC_PAGES=(60 61 62)
    # Measured per sheet: sheet 2's frame is about 0.6% wider and 2% taller than
    # sheet 1's, and sheet 3 sits between them. On all three the frame's left
    # border and the row-letter band are at or off x=0 in the scan, as on A14,
    # so x starts at 0 and nothing is lost.
    SCHEMATIC_CROPS=("6390x3790+0+260" "6430x3880+0+235" "6390x3865+0+255")
    PHOTO_SRC="$DOCS/Photos/a13_top.jpg"
    ;;
  a15)
    DRAWING_PAGE=70
    DRAWING_CROP="6115x3305+215+460"      # PCB outline incl. ejectors and P601/P602
    SCHEMATIC_PAGES=(71 72)
    # Measured separately: sheet 2's frame sits about 1.3% narrower than sheet
    # 1's and is shifted left, so one shared rectangle would clip one of them.
    # The outer border's left edge is at or off x=0 on both sheets, so x starts
    # at 0; on sheet 2 that band, and with it the left-hand row letters, is
    # already off the page in the scan.
    SCHEMATIC_CROPS=("6420x3910+0+240" "6335x3875+0+240")
    PHOTO_SRC="$DOCS/Photos/a15_top.jpg"
    ;;
  a16)
    DRAWING_PAGE=73
    DRAWING_CROP="5880x3360+330+430"      # PCB outline incl. ejectors and P701/P702
    SCHEMATIC_PAGES=(74 75 76)
    # The three sheets were reproduced at noticeably different scales -- sheet 1
    # and sheet 3 are about 13% larger than sheet 2 -- so each gets its own
    # rectangle. On sheets 1 and 3 the frame's left border and its row-letter
    # band are off the page, as on A14, so x starts at 0 and nothing is lost.
    # Sheet 2's circuit spills below its own frame (Q17, C28, C79, R57), so its
    # rectangle is taller than the frame and takes in the figure caption with it.
    SCHEMATIC_CROPS=("6380x3870+0+225" "5700x3860+710+315" "6370x3860+0+258")
    PHOTO_SRC="$DOCS/Photos/a16_top.jpg"
    ;;
  a11)
    DRAWING_PAGE=46
    DRAWING_CROP="5880x3340+250+440"      # PCB outline incl. ejectors and P401/P402
    SCHEMATIC_PAGES=(47 48 49 50 51 52)
    # Six sheets, and no two of them share a rectangle. Each was measured
    # separately against scripts/page_grid.py: the outer border sits anywhere
    # between x=0 and x=79 depending on the sheet, and sheets 2, 4, 5 and 6 are
    # scanned with about a quarter of a degree of skew, which moves the top
    # border 20-25 px between the left and right ends of the same line. The
    # rectangles below take the outer extreme of each skewed border rather than
    # its average, so a corner is never clipped -- the cost is a few px of white.
    # On sheets 3 and 4 the frame's left border and its row-letter band are off
    # the page in the scan, as on A14, so x starts at 0 and nothing is lost.
    SCHEMATIC_CROPS=("6320x3820+75+266" "6370x3900+20+230" "6420x3881+0+245" \
                     "6350x3898+0+252" "6325x3844+75+268" "6313x3818+5+256")
    PHOTO_SRC="$DOCS/Photos/a11_topn.jpg"   # covers removed; supersedes a11_top.jpg
    ;;
  a8)
    DRAWING_PAGE=30
    DRAWING_CROP="5350x3010+615+555"      # PCB outline incl. ejectors and P201/P202
    # Five sheets, counted off the title blocks rather than assumed: 5700A-1020
    # prints "(1 of 5)" through "(5 of 5)" on pages 31-35, page 30 is the locator
    # (5700A-1622) and page 36 is already A9's locator. Sheet 5 is the relay
    # state chart rather than a circuit -- extracted for reading, not for
    # placing components, exactly as A14's sheet 4 is.
    SCHEMATIC_PAGES=(31 32 33 34 35)
    # Measured per sheet off the outer rule of the D-sheet frame. The frame sits
    # at a different offset on every sheet and each is scanned with a fraction of
    # a degree of skew, which spreads one border over 10-15 px between the ends
    # of the same line, so each rectangle takes the outer extreme plus a few px.
    # On all five the frame's left border and its row-letter band are at or off
    # x=0 in the scan, as on A14, so x starts at 0 and nothing is lost. The
    # scan's own black page edge is at x=6597 and is darker than the frame; the
    # right-hand rule taken here is the one just outside the zone-label band.
    SCHEMATIC_CROPS=("6450x3935+0+220" "6405x3915+0+208" "6445x3890+0+224" \
                     "6375x3910+0+216" "6425x3890+0+230")
    PHOTO_SRC="$DOCS/Photos/a8_top.jpg"
    ;;
  a7)
    DRAWING_PAGE=25
    DRAWING_CROP="5330x2860+590+450"      # PCB outline incl. ejectors and P211/P212
    # Four sheets, counted off the title blocks: 5700A-1021 prints "(1 of 4)"
    # through "(4 of 4)" on pages 26-29, page 25 is the locator (5700A-1621) and
    # page 30 is already A8's locator (5700A-1622).
    SCHEMATIC_PAGES=(26 27 28 29)
    # Measured per sheet against the outer border of the D-sheet frame, found by
    # profiling four bands across each page rather than one: all four sheets are
    # scanned with a fraction of a degree of skew, which moves a border 10-25 px
    # between the two ends of the same line, and sheet 3 is reproduced about 3%
    # taller than sheet 1. Each rectangle takes the outer extreme of its skewed
    # border plus 4 px, so no corner is clipped. The scan's own black page edge
    # sits at x=6600 on every sheet and is darker than the frame -- the frame's
    # outer rule is the one 60 px outside the zone-label band, not that.
    SCHEMATIC_CROPS=("6234x3766+141+229" "6264x3773+165+218" \
                     "6418x3891+9+210" "6378x3906+54+202")
    PHOTO_SRC="$DOCS/Photos/a7_top.jpg"     # hybrid covers off; supersedes a7_tops.jpg
    ;;
  a9)
    DRAWING_PAGE=36
    DRAWING_CROP="6020x3400+85+385"       # PCB outline incl. ejectors and P311/P312
    # Four sheets, counted off the title blocks rather than assumed: 5700A-1031
    # prints "(1 of 4)" through "(4 of 4)" on pages 37-40, page 36 is the locator
    # (5700A-1631, title block "OHMS CAL ASSY") and page 41 is already A10's
    # Figure 7-10. The Ch7 caption on page 36 reads "Figure 7-9 A9 Ohms Cal PCA".
    SCHEMATIC_PAGES=(37 38 39 40)
    # Measured per sheet against the outer border of the D-sheet frame, found by
    # projecting the thresholded page onto each axis and then confirming every
    # corner by eye. No two sheets share a rectangle: sheet 2 is reproduced about
    # 2% smaller than sheets 1 and 3, and sheet 4 is shifted left far enough that
    # its frame's left border and row-letter band are off the page entirely (as
    # on A14), so its x starts at 0 and nothing is lost. The scan's own black
    # page edge sits at x=6600 on every sheet and is darker than the frame; the
    # frame's outer rule is the one 60 px outside the zone-label band, not that.
    SCHEMATIC_CROPS=("6317x3821+115+234" "6181x3686+95+275" \
                     "6321x3821+78+264" "6329x3875+0+235")
    PHOTO_SRC="$DOCS/Photos/a9_top.jpg"
    ;;
  a5)
    DRAWING_PAGE=17
    DRAWING_CROP="6020x3350+235+365"      # PCB outline incl. ejectors, J1/J2 and P111
    # Three sheets, counted off the title blocks rather than assumed: 5700A-1011
    # prints "(1 of 3)" through "(3 of 3)" on pages 18-20, page 17 is the locator
    # (5700A-1611, in-drawing title "A5 WIDEBAND OUTPUT ASSY 761346 REV") and
    # page 21 is already A6's locator (5700A-1610, Figure 7-6).
    SCHEMATIC_PAGES=(18 19 20)
    # Measured per sheet against the outer rule of the D-sheet frame, each border
    # found by projecting the thresholded page onto its axis and then confirming
    # the corner by eye at 2x -- the scan's own black page edge sits at x>6595 on
    # all three and is darker than the frame, so it is never the line taken.
    # No two sheets share a rectangle. On sheets 1 and 3 the frame's left border
    # is off the page (as on A14): sheet 1's row letters D-A sit at x~3, left of
    # the *inner* rule at x=40, and sheet 3 has no frame ink left of x=190 at all,
    # so both start at x=0 and lose only an already-clipped band. Sheet 2 keeps
    # its whole left band -- outer rule x=44, inner x=107, letters between them.
    SCHEMATIC_CROPS=("6336x3914+0+234" "6430x3882+38+221" "6330x3868+0+222")
    PHOTO_SRC="$DOCS/Photos/a5_topn.jpg"    # note the filename: _topn, not _top
    ;;
  a10)
    DRAWING_PAGE=41
    DRAWING_CROP="5700x3240+400+425"      # PCB outline incl. ejectors and P301/P302
    # Four sheets, counted off the title blocks rather than assumed: 5700A-1030
    # prints "(1 of 4)" through "(4 of 4)" on pages 42-45, page 41 is the locator
    # (5700A-1630) and page 46 is already Figure 7-11, A11 DAC PCA. Note the Ch6
    # duplicate of this locator is Figure 6-11 on Ch6 PDF page 41 -- a different
    # PDF that happens to share the number.
    SCHEMATIC_PAGES=(42 43 44 45)
    # Measured per sheet to the outer border of the D-sheet frame, each corner
    # confirmed by eye at 2x rather than probed: the scan's own black page edge
    # sits at x>6600 on every sheet and is darker than the frame. No two sheets
    # share a rectangle. On sheets 1 and 3 the frame's left border and its
    # row-letter band are off the page in the scan (as on A14), so x starts at 0
    # and nothing is lost; on sheets 2 and 4 that border is at x=32 and x=31.
    SCHEMATIC_CROPS=("6345x3806+0+283" "6365x3832+30+274" \
                     "6340x3810+0+266" "6370x3822+28+282")
    PHOTO_SRC="$DOCS/Photos/a10_top.jpg"
    ;;
  a6)
    DRAWING_PAGE=21
    DRAWING_CROP="5850x3230+380+330"      # PCB outline incl. ejectors and P101
    # Three sheets, counted off the title blocks rather than assumed: 5700A-1010
    # prints "(1 of 3)", "(2 of 3)", "(3 of 3)" on pages 22-24, page 21 is the
    # locator (5700A-1610, silkscreen "WIDEBAND OSC ASSEMBLY 761098 REV") and
    # page 25 is already A7's locator, 5700A-1621.
    SCHEMATIC_PAGES=(22 23 24)
    # Measured per sheet against the outer rule of the D-sheet frame, every
    # corner confirmed by eye at 4x rather than probed: the scan's own black
    # page edge sits beyond x=6550 on all three and is darker than the frame.
    # No two sheets share a rectangle. On sheets 1 and 3 the frame's left border
    # and its row-letter band are off the page in the scan (as on A14), so x
    # starts at 0 and nothing is lost; on sheet 2 that border is at x=88 and the
    # left-hand D/C/B/A letters are on the page, so the rectangle starts there.
    SCHEMATIC_CROPS=("6335x3830+0+230" "6367x3845+88+250" "6300x3820+0+250")
    PHOTO_SRC="$DOCS/Photos/a6_top.jpg"
    ;;
  a16a1)
    # The Power Amplifier Digital Control SIP, a daughter board plugged into
    # the bottom of A16. Ch7 page 77 is locator 5700A-1671 (Figure 7-20); the
    # board is small and sits in the middle of an otherwise empty page, so the
    # crop is the rounded-corner outline with a little white round it.
    DRAWING_PAGE=77
    DRAWING_CROP="3880x1380+720+1390"
    # One sheet, 5700A-1071, on page 78; page 79 is already A17's locator. The
    # frame's outer rules are at x~8 and x~6345, y~262 and y~4110, read off
    # scripts/page_grid.py.
    SCHEMATIC_PAGES=(78)
    SCHEMATIC_CROPS=("6360x3870+0+250")
    # No photograph of this board exists in Photos/; the photo step is skipped.
    PHOTO_SRC=""
    ;;
  a13a1)
    # The Oscillator Wideband SMD card that plugs into A13 ("U30" on A13's
    # silkscreen). Ch7 page 63 is locator 5700A-1652 (Figure 7-16), a small
    # board in the middle of the page.
    DRAWING_PAGE=63
    DRAWING_CROP="4560x1440+680+1250"
    # One sheet, 5700A-1052, on page 64; page 65 is A14's locator. Frame outer
    # rules at x~0 and x~6335, y~270 and y~4100.
    SCHEMATIC_PAGES=(64)
    SCHEMATIC_CROPS=("6360x3880+0+240")
    PHOTO_SRC=""
    ;;
  a21)
    # Rear Panel PCA. Ch7 page 93 is locator 5700A-1609 (Figure 7-25); the
    # board is L-shaped and the crop is its outline with the 5700A-1609 label.
    DRAWING_PAGE=93
    DRAWING_CROP="5860x3580+280+360"
    # Five sheets, 5700A-1009 (1 of 5) to (5 of 5), pages 94-98; page 99 begins
    # Figure 7-26, the hybrids. All five frames sit within x 0-6355 and
    # y 243-4110 (sheet 2's top rule is the highest, at y~243), so one
    # rectangle serves them all with 10-20 px of white on each side.
    SCHEMATIC_PAGES=(94 95 96 97 98)
    SCHEMATIC_CROPS=("6380x3900+0+225" "6380x3900+0+225" "6380x3900+0+225" "6380x3900+0+225" "6380x3900+0+225")
    PHOTO_SRC=""
    ;;
  *)
    echo "unknown assembly '$ASM' — add a config block to $0" >&2
    exit 1
    ;;
esac

DRAWING_WIDTH=3000      # px; enough to read every silkscreen designator at 1:1
SCHEMATIC_WIDTH=3600    # px; schematic text is finer than silkscreen
PHOTO_WIDTH=3400

OUT="$ROOT/assets/$ASM"
# Full-resolution upright crops are kept rather than discarded: the OCR seeding
# and QA-overlay tools work from them, and re-extracting costs a minute each time.
BUILD="$ROOT/.build/$ASM"
mkdir -p "$OUT" "$BUILD"
TMP="$BUILD"

# The scans are stored rotated 90 deg CCW relative to reading orientation.
upright() { magick "$1" -rotate 90 "$2"; }

echo "==> $ASM: board drawing (Ch7 page $DRAWING_PAGE)"
pdfimages -f "$DRAWING_PAGE" -l "$DRAWING_PAGE" -png "$CH7" "$TMP/raw_dr"
upright "$TMP/raw_dr-000.png" "$TMP/dr_up.png"
magick "$TMP/dr_up.png" -crop "$DRAWING_CROP" +repage "$BUILD/drawing_full.png"
magick "$BUILD/drawing_full.png" \
  -resize "${DRAWING_WIDTH}x" \
  -colorspace Gray -normalize -depth 8 \
  PNG8:"$OUT/drawing.png"
rm -f "$TMP/raw_dr-000.png" "$TMP/dr_up.png"

echo "==> $ASM: schematic sheets (Ch7 pages ${SCHEMATIC_PAGES[*]})"
n=0
for pg in "${SCHEMATIC_PAGES[@]}"; do
  n=$((n + 1))
  pdfimages -f "$pg" -l "$pg" -png "$CH7" "$TMP/raw_sh$n"
  upright "$TMP/raw_sh$n-000.png" "$TMP/sh${n}_up.png"
  magick "$TMP/sh${n}_up.png" -crop "${SCHEMATIC_CROPS[$((n - 1))]}" +repage "$BUILD/sch${n}_full.png"
  magick "$BUILD/sch${n}_full.png" \
    -resize "${SCHEMATIC_WIDTH}x" \
    -colorspace Gray -normalize -depth 8 \
    PNG8:"$OUT/sch$n.png"
  rm -f "$TMP/raw_sh$n-000.png" "$TMP/sh${n}_up.png"
done

if [ -f "$PHOTO_SRC" ]; then
  echo "==> $ASM: board photo"
  # Cropping a photograph is the exception, not the rule. The photos already
  # frame their board, and keeping the surrounding background preserves the
  # board corners and edges used as homography landmarks -- crop into those and
  # the alignment gets worse, not better. A crop is worth setting only where a
  # board is framed loosely enough that the wasted background makes it render
  # noticeably smaller than it need be, and then only after measuring the margin
  # to everything that belongs to the assembly rather than to the PCB alone: the
  # ejector levers, connector shells and standoffs all reach past the board edge,
  # and on A20 the levers turned a nominal 240 px of top margin into 30.
  if [ -n "$PHOTO_CROP" ]; then
    magick "$PHOTO_SRC" -crop "$PHOTO_CROP" +repage \
      -resize "${PHOTO_WIDTH}x" -quality 85 "$OUT/photo.jpg"
  else
    magick "$PHOTO_SRC" -resize "${PHOTO_WIDTH}x" -quality 85 "$OUT/photo.jpg"
  fi
fi

echo
echo "assets in $OUT:"
for f in "$OUT"/*; do
  printf '  %-14s %-12s %s\n' "$(basename "$f")" \
    "$(magick identify -format '%wx%h' "$f")" \
    "$(du -h "$f" | cut -f1)"
done
