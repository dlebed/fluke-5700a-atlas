# What has actually gone wrong

Every item here cost real time on one of A11–A18 and will recur on the next
board. They are grouped by the stage that produces them.

## Contents

- [Extraction](#extraction) — crop rectangles, borders, per-sheet sizes
- [Reading the drawing](#reading-the-drawing) — OCR settings, rotation, glyph
  confusions, tiers, boards that will not read
- [The schematic reads worse than the board](#the-schematic-reads-worse-than-the-board-and-fails-differently)
  — how much of a sheet's reads are wrong, and the legend blocks that look right
- [A second reader is still a reader](#a-second-reader-is-still-a-reader-and-it-fails-in-its-own-ways)
  — the vision-language model's own failure modes, and the subagent experiment
  that does not work
- [Test points](#test-points) — pad not label, net not legend, the free
  cross-checks
- [The data](#the-data) — unsigned rails, shifted cells, limits sold as
  nominals, the two revisions, parts that are in no list
- [Values, tolerances and ratings](#values-tolerances-and-ratings-are-read-out-of-the-description)
  — what `Parts.spec()` can and cannot parse, and how to count it
- [A capacitor over its rating](#a-capacitor-over-its-rating-is-your-mistake-not-the-instruments)
  — why a ratio over 1.0 is always your error
- [Positions and provenance](#positions-and-provenance) — containment, hand
  placement, what survives a rebuild
- [The pipeline can lie to you quietly](#the-pipeline-can-lie-to-you-quietly) —
  the 239 deleted placements, OCR-merged designators, hard-coded A18 text
- [Aligning the photograph](#aligning-the-photograph) — how to shoot it, which
  direction the homography runs, checking the photo's orientation before
  trusting an outline fit, landmark choice, and why the board edge is only the
  seed

## Extraction

**Crop rectangles.** Guessing them from the PDF is slow. Measure the outline
wanted — for the drawing, the board edge including ejectors and the connectors;
for a sheet, the outer border of the D-size frame — off the upright page with
`scripts/page_grid.py`, and confirm the proposed rectangle over the grid before
committing it. A crop that clips a designator is worse than one with a little
extra white, because what is clipped cannot be placed at all.

**Measure the border from x=0, not from a margin you assumed.** A17's sheet 2 was
cropped 80 px too far right because the probe that found its left border started
at x=100 and reported the first ink it saw — which was circuit content, not the
frame. The frame was at x=29. Probe the whole width, and confirm by cropping a
tall sliver of the left edge and looking for the row letters: they sit between
the outer border and the inner frame, so if no D, C, B or A is visible, the
border has been clipped off.

**Two sheets of one figure need not be the same size.** A17's were scanned about
3% apart, so one shared rectangle either clipped sheet 2's frame or left a fat
margin on sheet 1. `extract_assets.sh` takes a `SCHEMATIC_CROPS` array, one entry
per sheet, and `sheetImageSize` in the overrides accepts either one `{w,h}` for
both sheets or one per sheet id. Measure each sheet.

**Keep the full-resolution intermediates.** `.build/<asm>/drawing_full.png` and
`.build/<asm>/schN_full.png` are what the reader and every review tool work
from. The downscaled `assets/` copies are for the browser only.

## Reading the drawing

**Do not set a character whitelist.** `tessedit_char_whitelist` suppresses
recognition with the LSTM engine — on A18 it cut a tile's yield from 43 tokens
to 23. Constrain the output by snapping to the known designator set instead;
that set comes from the parts list, so it is authoritative and free.

**Rotation direction matters.** Vertical silkscreen reads bottom-to-top, so the
tile must be turned *clockwise* to bring it upright. Turning it the other way
produces confident nonsense rather than an obvious failure.

**Map boxes back with the right dimension.** When a rotated tile's boxes are
mapped back to page coordinates, the tile's *height* is the axis that becomes x.
Using the width silently shifts every rotated read.

**Q reads as C, 9 reads as S, 0 reads as O.** These are not random: they cluster
on particular glyph shapes. A hit that lands nowhere near its neighbours in the
same series is worth a look — on A18, `C202`, `C210` and `C212` were misreads of
`Q2xx` labels and had to be dropped, and `TP9` was read as `TPS` and therefore
attributed to TP5, leaving TP9 placed nowhere at all.

**Cross-pass agreement is the confidence signal, but review every tier.** Four
passes with different tiling, scaling and thresholds either land on the same spot
or they do not. Start with `ambiguous`, `single` and `collision`, because that is
where the errors concentrate — on A17, 8 of 9 ambiguous and 6 of 9 collision
markers were wrong. But `agreed` is not clean either: 4 of its 52 were wrong
there, and one of those (`Q1`, sitting on a row of test point labels) would have
sent a technician to the wrong end of the board. Rendering all of them takes a
few minutes; budget for it rather than trusting the tier.

Where a contested marker turns out to be right, promote it into the `board`
overrides so its badge stops warning about a disagreement that has been settled.

**Yield depends on the artwork, and some boards will not read.** A18 read well;
A17 managed 47% of its designators and no amount of tuning moved it. The cause is
visible once looked for: A17's silkscreen labels *touch* the component outlines,
so the 'CR' of a diode label is one connected blob with the diode body and the
recogniser never sees a character. Diagnose that in one step instead of sweeping
parameters — `scripts/text_only.py` thresholds a tile, keeps only connected
components smaller than a character, and shows what survives. If the letters
vanish along with the graphics, they were fused to them.

What that means is *tesseract* cannot read them, not that they are unreadable —
see *A second reader is still a reader* below for what to do instead. The
sequence is: reader for geometry, model for the missing names, hand placement for
the positions.

Spend the hand-placement budget on what a probe touches: every test point first,
then the parts a fault code or a rail circuit names.

## The schematic reads worse than the board, and fails differently

**A drawing has almost nothing on it but designators; a schematic is mostly
other text.** The reader cannot tell a designator from a value, a net name, a
pin number or a word in a title block, so on a schematic it produces confident
placements for all of them. A14 is the measurement: on the board 123 of 140
markers were right, and per tier

| tier | board | sheet 1 |
|---|---|---|
| agreed | 99 / 101 | 38 / 49 |
| ambiguous | 8 / 14 | 12 / 24 |
| single | 8 / 9 | 2 / 7 |

Same reader, same settings, same day. Budget the review accordingly: a sheet
needs roughly twice the attention per marker that a board does, and `agreed` on
a sheet is worth about what `ambiguous` is worth on a board.

Three more boards, reviewed marker by marker, say the same thing more bluntly —
**about a third to a half of what the reader finds on a sheet is wrong**:

| board | machine-read | kept | dropped |
|---|---|---|---|
| A11 (six sheets) | 506 | 245 | **261** |
| A12 (three sheets) | 292 | 197 | **95** |
| A13 (three sheets) | 345 | 239 | **106** |

Budget a full pass per sheet and expect to throw much of it away. The boards, by
contrast, came through nearly clean — A12's 129 `agreed`, 16 `single`, 9
`collision` and 7 `ambiguous` board markers were reviewed and **not one was
wrong**. The effort belongs on the sheets.

What it actually reads instead of a designator, in rough order of frequency: a
component value (`1.5M` as VR1, `196k` as Z1, `36.5k` as T1), a net name (`-5
LH` as L1, `I SNS` as Z1, `+44 S` as H8), a pin or port label (`IO4` as TP4,
`PA2` as R2, `D3` as Q3), and a word from a caption (`ABSOLUTE VALUE CIRCUIT` as
L1, `OUTPUT PEAK MEASURE` as MP1).

**The pinout legends are the single worst offender, and they look right.** Most
sheets carry a block of relay and transistor bottom-view legends, captioned with
the designators they apply to: `K1, K2, K4, K8, K10, K11, K14`. The reader sees
seven placements, several passes agree on them, and they arrive in the `agreed`
tier looking like the most trustworthy thing on the sheet. Eleven of A14 sheet
1's mistakes were this one block. The parts are genuinely on the sheet — their
contacts are drawn in the circuit — so the marker is wrong while the designator
is right, which is exactly the case a sanity check on the parts list will not
catch. Find the legend block first, drop everything inside it, and only then
review the rest.

**A relay state table is the same trap wearing different clothes.** Sheets that
carry a table of relay positions by range have column headers that are nothing
but designators — `K1`–`K9`, `Q6`–`Q12`, `U8A-D`, `U19A/B`. A12's sheet 3 lost
**40 of its reads** to that table and the bottom-view legends together, and four
of the wrong ones arrived in `agreed`. A14's sheet 4 is nothing *but* such a
table, which is why it gets no reader pass at all. If a sheet has a block that
is pure designators laid out in a grid, find it before reviewing anything else
and drop it wholesale.

**A designator with a section suffix is a correct read.** `U2C` is the third op
amp in U2, `K14A` is one set of K14's contacts. These are what the sheet prints.
Resolve them to the device rather than counting them as errors.

## A second reader is still a reader, and it fails in its own ways

A vision-language model does not segment into connected components, so it reads
the fused labels tesseract cannot; `tools/vlm_crosscheck.py` uses one to name
the designators tesseract missed. It will not give coordinates worth having, so
it contributes names and not positions.

Its merge report sorts the outcome into the four things worth knowing:

| | |
|---|---|
| **agreed** | both readers saw it — confidence, nothing to do |
| **model only, unplaced** | a hand-placement candidate, with a tile to look in |
| **reader only** | tesseract placed something the model cannot see — a likely misread |
| **not on this board** | a measured false positive |

On four A17 tiles that produced 23 placement candidates, all were confirmed
present when the region was rendered and inspected, and 4 of 6 "reader only"
flags were markers already known to be wrong.

**Measure it, do not trust it.** Run it against something already checked by
hand before letting it influence anything, and re-measure per model version —
every figure below moved between two of them. On A14 sheet 1, reviewed marker by
marker first: of 166 names the model gave, twelve were not designators on the
board and *all twelve were net names* — `PACOM` nine times, `I SNS`, `SCOM` —
which the prompt had explicitly told it to ignore. Zero inventions. Its "reader
only" column flagged 18 markers, and 12 of those were ones the hand review had
independently rejected: about two thirds precision, the same figure A17 gave.
That is a genuinely useful prioritised list and not a verdict.

**Runaway generation is the failure to watch, and dense sheets provoke it.** An
older model asked for the designators on one A17 tile answered with three correct
ones and then invented `U1` through `U428`; a newer one repeats a run of a dozen
instead. On A14's board tiles the model behaved; on sheet 1 two of twelve tiles
repeated themselves mildly; on sheet 2, which is dense with four-figure values
and pin numbers, **all four tiles tried** ran away — one into several hundred
lines of `[illegible]`, one into `CR1...CR416`, one into the integers from 1 to
484. The useful reading is always the first ten or twenty lines, before it stops
reading and starts counting. Keep those, discard the tail, and re-ask at a
smaller region if what the tail displaced is needed.

Repetition is the tell: `vlm_crosscheck.py` counts duplicates per tile and
reports them, and since a tile that size holds perhaps ten labels, a cardinality
ceiling catches the rest.

**Snapping to the known set does not filter this.** Most of `U1`…`U428` are real
A17 designators, so matching against the parts list would have laundered the
invention rather than caught it. What does catch it is that a real designator
appears in exactly one tile.

**Truncation reads as invention.** `R3` for CR3, `69` for C69 — a dropped leading
letter, not a fabrication. The merge step separates the two so the false positive
figure stays meaningful.

**A plausible number is the dangerous failure.** Asked for a stock number, the
older model returned `800367` where the page prints `800357`: it "corrected"
toward the value in the *other* parts list. That is the one case where the
self-validating join would have been fooled, because the error moved toward the
thing the join checks against. Trust the model on designators; cross-check every
digit field against tesseract and flag disagreement rather than picking.

**What it is good for here is the designator set, not positions.** Asked where
something is, it answers to about a label's width. Asked what is on this tile, it
is better than tesseract on exactly the labels tesseract cannot segment. Use it
to decide whether a marker is even plausible, and place by hand from there.

**Agent-based visual verification is a different thing, and it does not work.**
Everything above is a model asked to read text, which is what it is for. Asking a
subagent to judge whether a marker *looks* right is not: tried on A18, one
subagent spent 179k tokens and twenty minutes on a single tile and produced two
confident claims of misplacement, both false. Render the markers and look at them
yourself.

## Test points

**On the board, the marker goes on the pad, not on the label.** The pad sits
about 50 px right of its silkscreen text on the A18 drawing. A marker centred on
the text sends a probe to the wrong place, which is the one error this tool must
not make. Place every test point by hand and size the box to span label and pad
together.

Watch for displaced labels: TP14's text is pushed onto the board notch while its
pad stays in the row with the others.

**On the schematic, the marker goes on the net, not on the legend.** Every test
point is written twice on a sheet — once in the legend table that names its
signal, once beside the flag symbol on the net. The table is crisper text in a
neat column, so the reader prefers it, and a marker pointing at a table row
answers a question nobody asked. `build_coords.py` detects the legend from the
reads themselves and prefers a reading outside it; whatever it cannot resolve
goes in the `schematic` section of the overrides, placed by hand.

**Check each placement against the signal name printed beside the symbol.** The
sheet writes `-44 SR` next to TP9's flag, and the dataset already knows TP9
carries −44 SR. That cross-check is independent of the reader and it is what
catches a label attached to the wrong designator.

**The legend's own zone references are a second free check.** A17's legend reads
`TP1 = FR1COM (PG1D7)` — sheet 1, zone D7 — so once the grid frame is measured,
the derived zone can be compared against the printed one for every test point at
once. Treat a mismatch as a question rather than a verdict: on A17 it caught
nothing the eye had not, and two of its own entries (TP51, TP62) turned out to be
wrong where the marker was right.

**The notes column is a third place a designator name appears.** Sheet 2 carries
`TP65 IS THE LAST "TP" REF DES USED`, and the reader put TP65's marker on it. Any
line of prose naming a designator is a candidate the legend detector knows
nothing about.

## The data

**Negative rails are printed unsigned.** `-44 SR … 60V` in Tables 2-8/2-9 means
−60 V. Sign every nominal, and record the correction where the next person will
find it.

**Printed tables contain shifted cells.** The `+30 FR2R` row of Table 2-8 is
shifted one cell and loses its nominal. Recover the value from an identical
circuit if there is one, and mark it as recovered rather than read.

**A printed 'nominal' may be the band's limit rather than its centre.** Table
2-10 gives +17 S as +17.000 V ±475 mV, which would be +16.53 to +17.48 V. The
annotation on schematic sheet 1 says +17.0 to +17.95 V and fault code 3600 says
+17.0 to +18.0 V — the same width, half a volt higher. The table's cell is the
near limit. Two independent sources agreeing against a table is enough to follow
them, but record the table's printed value in `conflict` so the next person sees
the decision rather than rediscovering it.

**The parts list may name a connector after the socket it plugs into.** A17's
Table 6-22 lists J801 and J802; the drawing, the schematic and the board
silkscreen all say P801 and P802, and J801/J802 are the mating connectors on the
Analog Motherboard. A18's list does not do this. The reader will never match
either name, so place them by hand and note the conflict — otherwise the two
connectors on the board are simply unfindable.

**The manual disagrees with itself.** F201–F204 are 0.2 A in the parts list and
"2A" on the schematic annotation; TP8 is `+30FR2` in the sheet 1 legend and
`+30 FR2R` on the net label and in Table 2-8. Show both and note the conflict —
resolving it silently destroys the evidence.

**Two revisions of the parts list disagree, on purpose.** Join them on Fluke
stock number so the join validates itself, and report every row that fails to
join instead of merging it quietly. On A18 all 18 reported rows were genuine
findings: revision differences, a part present only in Rev 9, and a changed
fuse.

**A test point need not be in the parts list.** Only 9 of A17's 33 are: the wire
loops, which are a purchased part (`JUMPER,WIRE,NONINSUL`, stock 816090). The
other 24 are plated eyelets in the board itself, with no BOM line at all. They
are still real probe targets with real expectations, so `assemble.py` carries any
curated test point through whether or not the BOM knows about it and marks it
`notInParts`. Do not let a missing BOM row talk you out of placing one.

The two kinds are also physically different, which is worth putting in `kind`: a
loop takes a clip lead, an eyelet takes a probe tip.

**A test point can legitimately have no expected value.** A17's TP51–TP65 are
logic lines the manuals never tabulate. `check_data.js` rejects a missing nominal
by default, so say so deliberately with `noPublishedValue: true` — that keeps an
accidental omission failing while letting the honest case through.

**Mechanical parts have no silkscreen and no symbol.** Heat sinks, insulators,
washers, screws, rivets and ejectors belong in `notOnDrawing`. They stay
searchable in the parts list, but counting them as unplaced makes the coverage
badge lie and sends someone hunting for a washer that was never drawn.

## Values, tolerances and ratings are read out of the description

Nothing in the dataset stores a resistor's value or a capacitor's rating as a
number — they are parsed from the parts-list description at run time by
`js/parts.js`, so a corrected BOM corrects everything downstream. A new board
needs no work here if its descriptions follow the usual shapes, but it is worth
knowing what those are, because a shape nobody has met yet fails silently: the
part simply has no spec and its measurements come back `unscored`.

`Parts.spec()` reads the value and the tolerance. Fields are split on commas
**and** on `+-`, because the separator between a value and its tolerance is
sometimes missing — `RES,CF,51K+-5%,0.25W`. Tenths are written both ways, `.1`
as often as `0.1`. A trailing full stop is punctuation, not a digit: `3.9K.`

Four tolerance shapes turn up, and three of them were found only by counting:

| shape | example | what it means |
|---|---|---|
| symmetrical per cent | `+-5%` | the common case |
| asymmetrical | `+30-20%`, `+80-20%` | an electrolytic or Z5U part, generous up and tight down |
| absolute | `+-0.1PF`, `+-0.5PF` | a small ceramic, where a per cent of a few pF is not a usable number |
| missing comma | `+-20%.25V` | A18's C2 and C3; the rating is the 25 V after it |

The asymmetrical one matters more than its rarity suggests: averaging `+30-20%`
into a symmetrical ±25% fails a capacitor the manual considers good, and a
reading of +25% on such a part is in spec. Reading `+-0.1PF` needs to know the
field came after a `+-` — it is indistinguishable from a capacitance otherwise,
and on `CAP,CER,6.8PF,+-0.1PF` only the position says which of the two is the
part.

`Parts.spec()` **declines** rather than guessing: a resistor network states the
value of each element and not of the part (`RES,CERM,SIP,8 PIN,7 RES,10K`), so
anything matching R-NET, RNET, `N RES` or SIP returns nothing. A declined parse
costs a blank field; a wrong one silently accuses a good part of being out of
spec.

`Parts.ratedVoltage()` reads the working voltage for **every** capacitor kind,
not just tantalum — the same question is worth asking of an aluminium can. It is
the last bare voltage field in the description.

**Check a new board by counting, not by spot-checking.** Across the eight
assemblies the parser reaches 100% of every kind that states a value at all
(resistors 590, capacitors 489, zeners 113, thermistors 2) and 489 of 489
capacitors for the rating. The parts left over are fuses, ICs, connectors and
hardware, which state no measurable value. If a new board comes out materially
below that, it has a description shape nobody has met:

```bash
node -e "
const fs=require('fs'),vm=require('vm');const c={console};c.global=c;c.window=c;vm.createContext(c);
vm.runInContext(fs.readFileSync('js/parts.js','utf8'),c);
const sets=[];c.BoardExplorer={register:d=>sets.push(d)};
vm.runInContext(fs.readFileSync('data/a19.js','utf8'),c);
let n=0,ok=0; for(const p of sets[0].components||[]){
  if(!['res','cap','zener','thermistor','fuse'].includes(p.kind))continue;
  n++; if(c.Parts.spec(p))ok++; else console.log('  no spec:',p.ref,p.desc);}
console.log(ok+'/'+n+' parsed');"
```

## A capacitor over its rating is your mistake, not the instrument's

A solid tantalum run above its rated voltage fails on the first power-up. So if
an audit says one is sitting at 177% of its rating, the instrument would never
have worked, and the number is wrong rather than alarming. Treat a ratio over
1.0 as a flag to re-do two pieces of work by hand:

- **Re-read the rating from the parts list.** Check the voltage field on that
  row, and check the row is really this designator's — a merged designator range
  attaches one part's description to another part's reference, which is exactly
  the class of error the Rev 9 scan produces.
- **Re-trace the net.** Find the part on the sheet again and follow its
  non-grounded end. What matters is the worst case that node can reach, which is
  frequently not the rail that feeds the circuit around it.

It has been the second every time so far. A12's C1 and C2 were carried as ±44 S
on 25 V parts — 177%, the worst pair in the instrument. Sheet 1 shows
`+44S → R1 30k → VR1 (10 V) → VR2 (10 V) → R2 → −44S`, with C1 across VR1 and C2
across VR2: they see 10 V, about 40% of rating, and are fine. The audit had
recorded the rail feeding the divider instead of the node the capacitors are on.

Two smaller lessons came with it. The note in the audit already said "Near VR1
10V from +44S", so the evidence for the correct answer was sitting in the record
that carried the wrong one — read the note before trusting the number beside it.
And a 3 V part is not automatically alarming: A12's C22 and C25 are 3 V, and
they are AC coupling clamped by antiparallel diodes to one diode drop, which is
precisely why so small a part is right there.

## Positions and provenance

**Provenance must survive an export.** Each placement carries how it was arrived
at, and the app shows it. If a rebuild or an Author Mode export drops the
`placement` field, every hand-checked marker silently downgrades to "passes
agreed" — the tool then claims a machine read was checked by a person, which is
the one thing the tiering exists to prevent.

**A marker wholly inside another marker is almost always wrong.** Two parts do
not occupy the same board area. If one marker's box sits entirely within
another's, one of the two is misplaced — a resistor is never inside a resistor.
The exception is real but narrow: a physically large part, a transformer or a
big can or a hybrid, covers enough board that a neighbouring marker can fall
inside its outline. That makes containment *possible*, not correct, so look at
every one.

`node tools/check_data.js <asm>` reports these for the board and for each sheet.
It is a sharp signal with very little noise, because adjacent labels overlap
without containing: across A14, A17 and A18 it fired exactly once, and that once
was a genuine error nothing else had caught.

The reader's own collision check cannot find these. It compares *centres*, so a
small box well inside a large one, off to one side, passes it cleanly.

What it caught on A18: `MP2` and `MP201` were both on the `MP201` silkscreen.
MP201 is a two-pin header and its marker was right; MP2 is
`FOOT,RUBBER,ADHES,BLK` — a rubber foot, which has no silkscreen designator at
all and belonged in `notOnDrawing`. The reader had read `MP201` and truncated it
to `MP2`. Note how the error hid itself: MP2 *should* have shown up in the
unplaced list, where it would have been obvious, but the bogus marker made it
look placed. A truncation misread can quietly promote a part that has no
designator into one that appears to have a position.

**A hand-moved marker is hand-placed.** Anything dragged, nudged or typed into
position becomes `verified`, whatever the reader thought.

**`build_coords.py` regenerates from the reader plus the overrides file.**
Nothing else survives a rebuild. Fold Author Mode exports into
`data/<asm>.coords.overrides.json` with `tools/fold_overrides.py` rather than
leaving a `coords.json` that the next rebuild will overwrite.

## The pipeline can lie to you quietly

**`build_coords.py` will delete every schematic placement and say nothing, if
the sheet crops are missing.** `spaces.sheet_spaces()` decided which sheets an
assembly had by looking for `.build/<asm>/schN_full.png` — and those are build
intermediates, not versioned. The reader output that actually drives placement
*is* versioned. So on any fresh checkout the crops are absent, the function
returns no sheets, and the rebuild writes a coordinates file with every
schematic marker gone. Measured on A13: **239 placements, silently.**

Nothing downstream can catch this, because a board with no schematic placements
is a legitimate state — a board part-way through review looks exactly the same.
It is fixed (a sheet now counts if either the crop or the reader output is
there), but the shape of the mistake is worth remembering: **a derived input
that is not versioned, gating data that is.** Before and after any rebuild,
count what you have:

```bash
python3 - <<'EOF'
import json
d = json.load(open('data/a13.coords.json'))
p = d['placement']
print(len(p), 'entries',
      sum(1 for v in p.values() if v.get('board')), 'board',
      sum(len(v.get('sch') or []) for v in p.values()), 'schematic')
EOF
```

**A part the Rev 9 scan names and the 1996 list does not may not exist.** The
Rev 9 parts list is OCR, and it merges adjacent designators on one row: A14
gained a `C1214` from `C12` and `C14`, A17 a `Z521` from `Z51, 52`, A13 a `U0`
from the ESD-marker column of `U 5, 7, 11`. These cannot be placed, so they sit
in the unplaced list forever and quietly make the coverage badge lie.
`rev9_only_is_plausible()` now rejects a designator numbered past anything the
1996 list uses for that prefix, and rejects zero outright. It reports every drop
in `review.txt` — read those lines, because the same rule will occasionally
refuse a real part that a later revision genuinely added.

**Anything hard-coded in `assemble.py` was written when A18 was the only
board.** The generated file header cited `Table 6-23 and §5-23` for every
assembly for months. When adding a board, read what `assemble.py` writes, not
just what it reads.

## Aligning the photograph

The board photo has to be registered against the locator drawing or Photo,
Overlay and Swipe show a picture that does not line up with the markers. It is
four or more `{src, dst}` landmark pairs plus the homography solved from them,
kept in `data/<asm>.coords.overrides.json` under `layers.photo`, marked
`approximate: true`.

**`src` is board/drawing space and `dst` is photo space; H maps board → photo.**
`js/viewer.js`, `js/author.js` and `data/schema.md` all agree, and A12–A18 are
consistent with it. It is easy to assume the opposite and get a solve that
looks plausible and is inside out.

There is a two-minute way to be certain rather than to reason about it: take
three reviewed positions from a board that is *already* registered, push them
through that board's stored `H`, and look at where they land on its photograph.
If they land on their parts, the convention is what you think it is. Doing this
first costs nothing and settles a question that otherwise only surfaces after a
full solve.

**Check the photograph's orientation before fitting anything to its outline.**
A7's is rotated 180° with respect to its locator drawing, and A7 is a
near-rectangular board — so its silhouette is *nearly* symmetric under that
rotation, and a contour fit will converge on the wrong one, report a respectable
residual, and put every marker on a plausible wrong part. A residual cannot see
this; only landing markers on parts can.

Pin the orientation on features that are not symmetric, and on more than one:
A7 was fixed by four that agree — the DIN connectors overhang the drawing's top
edge and the photo's bottom; the ejector levers sit at opposite corners; the
three tabs along one edge run x≈700/1500/2300 on the drawing against
2790/1700/620 on the photo, mirrored in both axes; and the notch moves from
top-left to bottom-right. Establish orientation from those, then *exclude* the
levers and tabs from the fit itself, because they stand proud of the board.

**Do not use the ejector ears, standoffs or mounting holes.** They are the
obvious landmarks and they are wrong: they stand proud of the board and show
15–20 drawing px of parallax against a flat drawing. On A11 the top-right ear
and the mid-right standoff disagreed by 0.02 normalised. Use flat, in-plane
silkscreen only.

**The drawing does not print designator text where the board does.** Fluke moved
much of it inside the part outline for legibility, so part *outlines* coincide
exactly while text can sit a character-height away. Land landmarks on outlines,
and zoom in on each one to check it reads convincingly.

**What is fitted to the board decides how good the answer can be.** A11's first
alignment had both hybrid covers and a shield in place, which left no usable
silkscreen right of x≈0.80: nine landmarks, fourteen validation patches, p90
14 px — against three-pixel medians and 35 patches on the boards with nothing
covering them. The right-hand column was spanned rather than anchored, and
positions under the covers were the homography's word rather than a
measurement. Say so in the credit when that is the case, and re-shoot with the
covers off if possible — it is a far better fix than a cleverer solve.

A method that works: the locator drawing *is* the silkscreen artwork and the
photo shows the same silkscreen in yellow ink, so extract thin strokes from
both, warp the photo into board space and cross-correlate patch by patch. Take
each `src` from the reviewed board coordinate already in `coords.json` — the
same point the markers use — so every pair is a checkable correspondence rather
than a sample of a matrix.

**Open the photograph before writing down what it shows.** A5 was carried for a
long time as the one board that could not be aligned, on a caveat that named
the attenuator shields as fitted and said nothing left of x≈0.28 was visible.
None of it was true. The pale rectangle in the left third is not a lid, it is
the PTFE RF laminate the attenuator is built on — board material, with its own
plated via ring, its own pads and its own silkscreen, every designator on it
legible, and the blue PCB running round all four sides. Registration then went
in at a median 2 px from 32 landmarks, four of them on the laminate. A caveat
that says a board *cannot* be done is the one worth re-checking against the
image, because nobody re-checks it afterwards.

**Shoot the board on a contrasting background — that is a requirement, not a
preference.** The board outline is the one feature every board has, in both
views, at full extent, and it segments in one step when the background is plain
and light and the board is dark. Every alignment below starts there. A photo
taken on a cluttered bench throws that away and leaves nothing but silkscreen,
which is slower and worse on the boards that need it most. When re-shooting is
an option, plain paper under the board is the whole technique — and take the
shields, covers and harnesses off while it is out.

**Fit the outline as lines, not as corners or as points.** This is the method
that works, and the two ways of getting it wrong both look reasonable:

- *Corners as points* is what failed on A4 first. Five corner pairs solved to a
  6 px worst residual and were still wrong — J13, J16 and J41 landed ~180 px
  out — because an L-shaped board crowds three of five corners into one quarter,
  so the fit anchored there and was extrapolated across the long section.
- *Iterative closest point* was then tried and rejected. It is pulled by corners
  the drawing draws sharp and the photograph shows rounded: 20 px off along
  A4's right edge and 47 px at the bottom-right corner.

What worked was fitting **each straight edge as a line** — A4 has seven: bottom,
top of the long section, left, right, arm top, and the arm's left edge above and
below its step — and requiring every outline pixel to land on the *line* of its
edge rather than on a point of it. A point mid-edge measures across the edge but
says nothing along it, which is exactly the constraint the corners lacked. That
gave median 1.44 px over 5,309 outline pixels, and a fit that agrees with one
made to all of them to within 3.0 px everywhere.

**Mask where anything crosses the outline** before fitting, on both sides: on
A4 the loom leaving the arm's right edge, the loom and tie-wrap over the L's
inner corner, the line-filter bracket over the bottom-left, and F1/SW2–SW4
standing over the right edge — and on the drawing, the mains lead and plug it
prints *outside* the outline.

**The drawing's outline has gaps.** A4's is broken by up to ~55 px, so flood
filling the white background leaks straight through it and takes the board with
it. Dilate the ink by ~32 px, flood, fill, undo the dilation, then keep only
boundary pixels that sit on drawn ink — which discards the bridges the closing
built across the gaps.

**Where the edge stops being the answer.** The camera sees the top face of a
1.6 mm board from above and the segmentation takes the edge shadow with it, so
the edge sits a few pixels outside the plane the silkscreen is in: A5's
edge-only and silkscreen fits differ by a median 8 px and 25 px at the corners.
On a sparse board with long straight edges and large parts — A4's connectors —
that bias averages out along each edge and never shows. On a dense board with
runs of small parts it puts you on the neighbour. So: line-fit the outline
first, and on a dense board finish on the artwork.

Author Mode's *Align outline* has that ceiling by construction — four corners,
and those corners are the part of the board least in the silkscreen's plane. It
is the right tool for a board with no fit at all, or for a user's own photo of
their own revision, and the wrong one to stop at.

**A marker that looks misplaced on the photograph may be a placement fault, not
a registration one.** Separate the two before touching either. A7's TP11 and
TP18 have boxes that span their printed *labels*, and on that board the labels
sit ~50 drawing px below the loops they name — so through a correct homography
both land exactly on the lettering and look wrong. The fix is a taller box, the
way TP5's and TP7's already are, which is reviewed placement data and a separate
edit from the alignment. Record it and leave it; do not bend the homography to
cover for a box.

The same care applies the other way round. Where a correlation disagrees with
the consensus fit, open it at full resolution before assuming the marker is
wrong: on A7 four disagreed and in every case the marker was right and the
correlation patch had been dominated by relay bodies or a cover.

**Anchor the parts of the board the silkscreen method is weak on.** Cross-
correlating yellow ink works where there is yellow ink; a region of black
packages with little lettering — A7's Q1/Q6–Q13 end — contributes few confident
peaks and gets spanned rather than measured. A Huber refit over every
correlation, rather than discarding everything the consensus rejected, pulls
that end back by roughly 10 px on A7. Say in the credit which regions are the
fit's word rather than a measurement.

**Decide which correlation peaks to believe with RANSAC, not with the running
fit.** Accepting a peak because it agrees with the current homography converges
on whatever it started from, and on a board with rows of identical resistors
15–20% of confident-looking peaks are locked onto the neighbour. Take every
peak, let a consensus over all of them choose the model, then re-match. A5's
tally: 213 placements correlated, 112 unambiguous, and the 101 rejected split
between parts buried under their own components and runs of identical parts.
