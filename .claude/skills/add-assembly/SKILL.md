---
name: add-assembly
description: This skill should be used when the user asks to "add an assembly to the atlas", "add A11/A12/…/A21", "cover another board", "extract a board's drawing or schematic sheets", "pull in the parts list for a PCA", "rebuild a dataset" or "extend the pipeline to a new board", and when the user asks where an assembly's drawing, schematic or parts table lives in the 5700A/5720A service manuals. Use it as well for any work on the atlas's data pipeline — extract_assets.sh, build_data.py, ocr_designators.py, build_coords.py, assemble.py, check_data.js — and for component placement, OCR coordinates, coordinate overrides, test point expectations, the capacitor audit or Author Mode, even when the pipeline and its scripts are not named.
---

# Adding an assembly to the Fluke 5700A Atlas

The engine is assembly-agnostic: a board is one data file plus four images.
Adding one is a data job, not a code job. Reaching for `js/` is the sign of a
wrong turn — either the schema already covers the case, or the change is a
separate piece of work that should be raised as one.

Run everything from `fluke-5700a-atlas/` (the repository root).

## What the pipeline can read, and what needs hands

The pipeline reads the manuals by machine wherever the manuals can be trusted,
and asks for hands wherever they cannot. Knowing which is which is most of the
skill:

| | |
|---|---|
| **Text layer, trustworthy** | Parts list and supply tables in the 1996 manual. `pdftotext -layout` — no OCR, no risk. |
| **Scan, needs OCR, then checking** | Manufacturer columns in the Rev 9 parts list; every designator position on the drawing and sheets. |
| **Hands only** | Expected voltages and tolerances, test point positions, and any place two sources disagree. |

The last row is where the tool earns its keep, so it is the row worth spending
time on. A wrong marker sends a probe to the wrong pad; a wrong tolerance calls
a good supply bad.

## The sequence

Seven steps, each with a gate. `a19` stands in for the assembly throughout.

| Step | Does | Gate |
|---|---|---|
| 1 Pages | look the assembly up in `references/page-map.md` | title block names the assembly |
| 2 Assets | `tools/extract_assets.sh a19` | board fills the frame, no designator clipped |
| 3 Parts | `tools/build_data.py a19` | `.build/a19/review.txt` read end to end |
| 4 Test points | hand-write `data/a19.testpoints.json` | every value carries a source |
| 5 Positions | `tools/ocr_designators.py a19 <space>`, then `tools/build_coords.py a19` | every marker looked at, not read as numbers |
| 6 Assemble | `tools/assemble.py a19`, then `node tools/check_data.js a19` | check passes, coverage badge honest |
| 7 Completeness | the audit below | every feature the board offers has data behind it |

Do not carry a failing gate forward: the errors compound, and bad parsing is far
harder to find once coordinates have been built on top of it. And read
`references/pitfalls.md` before step 5 at the latest — it catalogues the
failures this pipeline has actually produced, several of which stay invisible
until they have cost an afternoon.

### 1. Find the pages

`references/page-map.md` lists, for all 25 assemblies, the Chapter 7 PDF page of
the component locator drawing, its schematic sheets, the 1996 parts table, and
the Rev 9 parts list page. Look the assembly up there rather than hunting.

**Gate:** render the drawing page and confirm the title block names the
assembly. One command, and it catches a page-numbering surprise before it costs
an hour. The Sheets and Rev 9 Ch6 columns each need confirming as well, for
different reasons — *How this was derived* in `page-map.md` says how.

### 2. Assets

Add a config block to `tools/extract_assets.sh` (copy A17's and edit), then run
`tools/extract_assets.sh a19`.

Crop rectangles are the fiddly part. The drawing crop is the board outline
including ejectors and connectors; the schematic crop is the outer border of the
D-sheet frame, measured per sheet, since two sheets of one figure are not always
the same size. Measure by eye with `scripts/page_grid.py`, which puts a labelled
grid over the upright page so the corners can be read off in full-resolution
pixels. Probing for the border in code finds the scan's own black page edge as
readily as the frame and cannot tell the two apart — see *Extraction* in
`references/pitfalls.md`, all three entries.

**Gate:** look at `assets/<asm>/drawing.png` and every sheet. The board should
fill the frame with little white margin, and no designator should be cut off.

### 3. Parts and procedures

Add a block to `CONFIG` in `tools/build_data.py` naming the parts table, the
Rev 9 BOM pages, the supply tables and the troubleshooting section, then run
`tools/build_data.py a19`. Set `procedure` to `None` for the boards Chapter 5
never covers — see *Troubleshooting* in `references/page-map.md`.

If the board introduces a designator family no earlier assembly had, add it to
`DESIGNATOR_PREFIXES` and `KIND_BY_PREFIX` in `build_data.py` and to the two
label maps in `js/app.js`. A17 brought L, T, X, Y and SW; A11 brought `A` (its
two plug-in SIP daughter boards carry sub-assembly designators) and A13 brought
`HS` (heat sinks); A4 brought `RV` and a `varistor` kind, since filing one under
`res` hands `Parts.spec()` "VARISTOR,22V,+-20%,1.0MA" and gets back a 22 Ω
resistor; A20 brought `BT`, `DS` and `XBT`. Without the prefix the parts are
dropped from the BOM silently, and the review report will not mention it.

A new *kind* needs three maps in `js/app.js`, not two — `KIND_COLORS`,
`KIND_LABELS` and `kindLabel`'s `names`. A kind with a label and no colour falls
through to `part`, which renders near `cap`, so the family is then mislabelled
on the board rather than on the card.

One prefix can mean different things on different boards, and a wrong kind is a
wrong label on the part's card. `HR` is a resistor network on A15 and a hybrid
module on A11 and A16, so those two override it in `KIND_BY_PREFIX_BY_ASM`
rather than bending the shared map. A kind that reads oddly on a finished card
is the symptom of this.

**Gate:** read `.build/<asm>/review.txt` end to end. It lists every row where the
two parts lists disagreed or parsing was uncertain. These are findings, not
noise — on A18, every one of the 18 was a genuine revision difference. Resolve
each into the data or into a note; do not leave them unread.

### 4. Test point expectations — by hand

Write `data/<asm>.testpoints.json` from the supply table and the schematic
legend box. This file is the one worth being careful with; everything else is
recoverable from the PDFs. `data/schema.md` documents the fields.

The supply tables print negative rails as unsigned magnitudes (`-44 SR … 60V`
means −60 V), so sign every nominal. Where a point's expectation depends on how
the supply is jumpered, use `states[]` rather than pretending one number fits.
Cite the table or section for every value in `source`, and mark anything
inferred rather than read as inferred — the app shows the citation, and a value
with no source cannot be checked by the next person.

Read *The data* in `references/pitfalls.md` alongside the table rather than
afterwards: shifted cells, a nominal that is really the band's limit, a test
point in no parts list, a test point with no published value at all.

### 5. Positions

```
tools/ocr_designators.py a19 board       # then sh1, sh2, …
tools/build_coords.py a19
```

The reader runs four passes with different tiling, scaling and thresholds, and
whether they land on the same spot is the confidence signal — `agreed`,
`ambiguous`, `single`, `collision`. That tiering is what makes it possible to
spend review time where it is needed instead of on all 250 parts.

How far the reader gets is a property of the artwork, not of the settings: A18
read well, A17 managed 47% because its labels touch the component outlines.
`scripts/text_only.py` tells the two cases apart in one run, so check that before
sweeping parameters. Where the labels are fused, tuning is wasted — get a second
opinion instead (step 5b) and then place by hand.

A schematic sheet reads far worse than a board and fails differently: it is
mostly text that is not a designator. Read *The schematic reads worse than the
board* in `references/pitfalls.md` before reviewing sheets, and find the pinout
legend block first — it is the one that arrives in the `agreed` tier looking
trustworthy and is wrong wholesale.

**Gate:** review the positions by eye; coordinates cannot be checked by reading
them. `scripts/review_markers.py` renders markers back onto the full-resolution
image so it is visible whether each box sits on its own label. The shorthand
below assumes `fluke-5700a-atlas/` (the repository root) as the working directory; open the
printed paths to look.

```
S=.claude/skills/add-assembly/scripts/review_markers.py
python3 $S a19 board --tier ambiguous     # the doubtful ones first
python3 $S a19 board --tier collision     # then contested, then single
python3 $S a19 board --refs C1 R5 TP4     # or specific parts
python3 $S a19 sh1 --grid 0.39 0.40       # a pixel grid, to measure by eye
```

Review `ambiguous`, `collision` and `single` first — that is where the errors
concentrate — but review `agreed` too. It is the best tier, not a clean one: 4 of
A17's 52 agreed markers pointed at the wrong part. The `--grid` mode is how to
place something the reader never found: read the label's centre off the grid,
divide by the image dimensions the script prints, and write it into the
overrides.

Corrections go into `data/<asm>.coords.overrides.json` in pixel coordinates,
under `board` for the drawing and `schematic` for the sheets; then rebuild. A
marker that points at another part's label is better dropped than nudged —
`drop` records it, and the coverage badge then tells the truth. Test points are
placed by hand as a matter of course, on the board and on the sheets both; *Test
points* in `references/pitfalls.md` says why, and what to check each placement
against.

### 5b. A second opinion, where the reader did badly

A vision-language model does not segment into connected components, so it reads
the fused labels tesseract cannot — on the A17 tile where tesseract found only
`U3` after sixteen setting combinations, the model read `Z1 CR7 CR5 U3`. What it
cannot do is say *where*: asked for coordinates it answers to about a label's
width, which finds a marker but does not place one. So tesseract keeps geometry
and the model answers "which designators are on this tile".

`tools/vlm_crosscheck.py` runs that as plan → ask → merge, because the model is
reached over MCP and a script cannot call it:

```
tools/vlm_crosscheck.py plan a17 board --grid 6x4
# ask the model the manifest's question about each tile, write answers.json
tools/vlm_crosscheck.py merge a17 board
```

Read *A second reader is still a reader* in `references/pitfalls.md` before
acting on the report. It explains the four outcomes the merge sorts into, the
runaway generation that dense sheets provoke, and why the precision figures have
to be re-measured against something already checked by hand rather than
inherited — they move with the model version.

### 5c. The capacitor audit, if the board has electrolytics

Recap mode ranks tantalums by voltage margin and aluminiums by how much
capacitance they have lost, and it needs one thing the parts list cannot give:
which rail each capacitor sits on. The rated voltage is read from the
description at run time, so only the applied side is curated, into
`data/<asm>.caps.json` — net name, working voltage, how the rail is fused, and
whether the net was traced on a sheet or inferred. `tools/import_cap_audit.py`
folds a spreadsheet of that work into the file. Leave `appliedV` null where the
net was not traced: a board with no audit shows no margins, which is a different
statement from showing good ones.

One result is always an error in the data rather than a finding: **a capacitor
that comes out above its own rating.** Fluke did not ship a part that would fail
on first power-up, so a ratio over 1.0 means the rating or the rail was recorded
wrong. *A capacitor over its rating* in `references/pitfalls.md` gives the two
re-checks and the A12 case that shows which of them it usually is.

### 6. Assemble and check

```
tools/assemble.py a19
node tools/check_data.js a19
```

Then add `<script src="data/a19.js"></script>` to `index.html`, open
`index.html?assembly=A19`, and search a few designators.

**Gate:** `check_data.js` passes, and the coverage badge is honest — parts with
no silkscreen designator belong in `notOnDrawing`, not in the unplaced count.
Then look at the board in all six display modes and open one test point, one
fault code and one schematic jump. That is when a missing kind label or a dead
empty state shows up, which no checker will catch.

### 7. What a finished board has to carry

The app has grown several features that each depend on their own slice of data,
and a board can pass `check_data.js` while quietly having none of it. Each row
below fails in a way that looks like the feature is broken rather than the data
is missing.

| What | Feeds | Missing looks like |
|---|---|---|
| board placements | markers, search, the pulse | parts that cannot be shown |
| **schematic placements** | the schematic jump, and clicking a part turning to its sheet | clicking a part does nothing |
| test points on board **and sheets** | the Test points tab, procedure steps | a step offers nothing to measure |
| `layers.photo` landmarks + H | Photo, Overlay, Swipe | photo does not line up with markers |
| `data/<asm>.caps.json` | Recap's tantalum ranking | every capacitor reads "rail not traced" |
| parseable descriptions | values, tolerances, ratings, ESR bounds | measurements come back `unscored` |
| `foreignStepRefs` | procedure steps that name another board's points | a step sends you probing the wrong assembly |

One command answers most of it:

```bash
node -e "
const fs=require('fs'),vm=require('vm');const c={console};c.global=c;c.window=c;
c.localStorage={getItem:()=>null,setItem:()=>{}};vm.createContext(c);
for(const f of ['parts','caps'])vm.runInContext(fs.readFileSync('js/'+f+'.js','utf8'),c);
const s=[];c.BoardExplorer={register:d=>s.push(d),emit:()=>{},state:{}};
vm.runInContext(fs.readFileSync('data/a19.js','utf8'),c);
const d=s[0], items=(d.components||[]).concat(d.testpoints||[]);
const photo=(d.layers||[]).find(l=>l.id==='photo')||{};
console.log('board placed   ', items.filter(i=>i.board).length, '/', items.length);
console.log('schematic      ', items.filter(i=>(i.sch||[]).length).length);
console.log('test points    ', (d.testpoints||[]).length,
            'of which on a sheet', (d.testpoints||[]).filter(t=>(t.sch||[]).length).length);
console.log('photo aligned  ', !!(photo.transform&&photo.transform.H),
            '(' + ((photo.landmarks||[]).length) + ' landmarks)');
console.log('cap audit      ', Object.keys(d.capAudit||{}).length, 'capacitors');
const ta=c.Caps.list(d,{types:['TA']});
console.log('tantalums      ', ta.length, 'of which no rail traced',
            ta.filter(a=>a.risk==='unknown').length);
"
```

A zero in the schematic row on a board already reviewed is the trap in *The
pipeline can lie to you quietly* — check that before assuming the review was
lost. The descriptions row has its own count-don't-spot-check recipe under
*Values, tolerances and ratings*.

## Author Mode

`index.html?assembly=A19&author=1` beats editing JSON for a handful of
corrections: drag to move, handles to resize, arrows to nudge, `Cmd/Ctrl+Z` to
undo, *Export coordinates* to write a `coords.json`.

For a marker that should be the **component body** rather than its designator,
draw it instead of nudging it: pick Box or Circle, then sweep the outline —
corner to corner for a box, rim to rim across the middle for a circle. With
*Snap* on it is fitted to the printed outline, within 15%, which on A18 turns a
median 12 px of hand error into 1.5 px. `Del` throws an outline away and waits
for a new one. Snapping reads the drawing only, never the photo, and needs the
page served rather than opened from `file://` — `python3 -m http.server`.

*Align outline* is the quick way to register a photograph: it pins the photo's
four corners as a draggable quad, and dragging one re-solves the homography live
until the board edge sits under the drawn one. It seeds an identity fit on a
board that has none, so it works from nothing — which also makes it the tool for
a technician who replaces `assets/<asm>/photo.jpg` with a shot of their own
board and needs it lined up again. Four corners is its ceiling, and the corners
are the part of the board least in the silkscreen's plane; *Aligning the
photograph* in `pitfalls.md` says what that costs and when to finish on the
artwork instead.

One trap: `build_coords.py` regenerates positions from the reader plus the
overrides file, so it overwrites an exported `coords.json`. Anything that should
survive a rebuild belongs in `data/<asm>.coords.overrides.json`, in pixels of
`.build/<asm>/drawing_full.png` — which is *not* the image the browser loaded,
so do not convert by hand. `fold_overrides.py` folds positions **and**
`layers.<id>.landmarks`, so an alignment made in the browser survives the next
build rather than reverting to whatever the overrides file still said:

```
tools/fold_overrides.py a19 ~/Downloads/a19.coords.json --dry-run
```

## Bundled files, and when to open each

- `references/page-map.md` — **step 1, and again before step 3's `procedure`
  entry.** Every assembly's pages, how the mapping was derived, and how far each
  column can be trusted.
- `references/pitfalls.md` — **before step 5 at the latest, then per stage.** The
  failures this pipeline has produced and what each looked like, grouped by
  stage, with a contents list at the top.
- `scripts/page_grid.py` — **step 2.** A labelled measuring grid over a
  full-resolution page, so a crop rectangle is read off it rather than guessed;
  `--crop` draws a proposed rectangle over the grid to confirm it first.
- `scripts/text_only.py` — **step 5, when the reader's yield is poor.** Keeps
  only character-sized ink on a tile, which separates "the settings are wrong"
  from "the labels touch the artwork".
- `scripts/review_markers.py` — **step 5's gate.** Markers rendered onto the
  source image and tiled, by tier or by designator; `--grid` to measure a
  position by eye; `--proposed` to look at a hand placement before it lands.
- `tools/vlm_crosscheck.py` — **step 5b.** In the repo rather than the skill:
  reads the drawing a second time with a vision-language model and reconciles
  the two readers.
