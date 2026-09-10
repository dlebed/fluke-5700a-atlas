# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

`README.md` describes what the tool does and how to use it. This file covers what
is not visible from the outside: how the two halves fit together, and the
conventions that have already cost someone an afternoon.

## Hard constraints

**The page must work as standalone HTML, opened straight from disk.** No build step, no
package manager, no network, no modules. `js/*.js` are ES5-style IIFEs hanging
one global off `window`; datasets are `<script src>` files that call
`BoardExplorer.register()` at load time rather than being fetched. There is no
`package.json` and adding one would be a change of direction, not a convenience.

The one thing this costs: `snap.js` reads pixels back out of a canvas, which the
browser forbids once a `file://` image has been drawn into it. Author Mode's
snapping therefore needs the directory served — `python3 -m http.server` — and
says so rather than failing silently.

**`test-logs/` is a service record, not tool data.** If it exists it holds
readings exported from the app for a physical instrument: it belongs to whoever
did the work, it is not reproducible from anything in this repository, and it is
gitignored. Never modify it, and never let a test or a script write there.

**Never call `localStorage.clear()`** or delete a key a test did not create. The
service log lives in local storage and there is no other copy.

## Commands

There is no test runner. `check_data.js` is the verification step, and it is the
one to run after any rebuild:

```bash
node tools/check_data.js a18          # integrity: dangling COM refs, uncited
                                      # expectations, steps naming absent parts
```

The per-board pipeline, in order. Each stage has a gate; a failing gate must not
be carried forward, because bad parsing is far harder to find once coordinates
have been built on top of it.

```bash
tools/extract_assets.sh a18           # PDF -> assets/a18/{drawing,sch1..N}.png, photo.jpg
tools/build_data.py a18               # parts list + procedure -> .build/a18/
tools/ocr_designators.py a18 board    # then sh1, sh2, ... one per sheet
tools/build_coords.py a18             # reader + overrides -> data/a18.coords.json
tools/assemble.py a18                 # curated + coords -> data/a18.js
```

On a brand-new board run `tools/assemble.py <asm>` once *before*
`ocr_designators.py`: the reader takes its designator list from
`data/<asm>.js`, and fails on a board that has none yet.

```bash
# Step 5's visual gate: markers rendered back onto the full-resolution image.
# Coordinates cannot be checked by reading them.
python3 .claude/skills/add-assembly/scripts/review_markers.py a18 board --tier ambiguous
python3 .claude/skills/add-assembly/scripts/page_grid.py ...     # measure a crop by eye
tools/fold_overrides.py a18 ~/Downloads/a18.coords.json --dry-run # one board's export -> overrides
tools/fold_bundle.py ~/Downloads/a-author-bundle.json --dry-run   # every board, then rebuild + check
```

`fold_bundle.py` is the one to reach for after an "Export all boards": it
folds each board through `fold_overrides.py`, rebuilds only what it touched,
and reports the three things a bundle hides — which designators gained a first
schematic position, which boards changed nothing but formatting, and which
edits the coordinates cannot carry. **An export folds through the overrides or
it does not last**: `data/<asm>.coords.json` and `data/<asm>.js` are both
regenerated, so an export written straight into them survives until the next
build and no further.

Open one board directly: `index.html?assembly=A18`, plus `&author=1` for the editor.

## Architecture

Two halves that meet at `data/<asm>.js`.

**The engine (`js/`) is assembly-agnostic.** It knows nothing about any
particular board — a board is one data file plus four images. Reaching for `js/`
while adding an assembly is the sign of a wrong turn: either the schema already
covers the case, or it is a separate piece of work that should be raised as one.
The sanctioned exception is adding a new designator family to the two label maps
in `app.js`, mirroring `DESIGNATOR_PREFIXES` / `KIND_BY_PREFIX` in
`build_data.py`.

`registry.js` is the whole coupling mechanism: a dataset registry, a shared
mutable `state`, and a three-function event bus (`on` / `emit` / `set`).
Everything else subscribes. `set()` diffs before emitting, so a no-op patch does
not redraw. There is no framework and no reactivity beyond this.

**The pipeline (`tools/`) is per-board and mostly Python.** It reads the manuals
by machine wherever they can be trusted and asks for hands wherever they cannot:

| | |
|---|---|
| Text layer, trustworthy | parts lists and supply tables in the 1996 manual — `pdftotext -layout`, never OCR |
| Scan, needs OCR then checking | manufacturer columns; every designator position |
| **Hands only** | expected voltages and tolerances, test point positions, and anywhere two sources disagree |

That last row is where the tool earns its keep. A wrong marker sends a probe to
the wrong pad; a wrong tolerance calls a good supply bad.

**Generated vs curated.** `data/<asm>.js` and `data/<asm>.coords.json` are
output — never hand-edit them. The curated inputs are `<asm>.testpoints.json`
(expected values and their citations), `<asm>.reference.json` (fault codes,
circuit blocks, caveats), `<asm>.caps.json` (which rail each capacitor sits on,
for Recap mode) and `<asm>.coords.overrides.json` (hand corrections over the OCR
pass). `data/schema.md` documents the fields.

## Conventions that bite

**A marker's `x,y` is the box centre, not its top-left.** See
`Viewer.prototype.screenBox` in `js/viewer.js`. Any verification that draws
boxes from `x,y` as a corner will show every marker shifted onto a neighbouring
part and look like a real bug.

**Override coordinates are integer pixels of `.build/<asm>/drawing_full.png`**,
which is *not* the image the browser loaded, and sheets have per-sheet sizes.
Do not convert by hand — `tools/fold_overrides.py` does it. Comparing override
boxes with a float epsilon is wrong for the same reason: one pixel of a 6380 px
sheet is 1.6e-4, so an epsilon smaller than that reports every entry as edited
forever. Compare on the integer pixel grid.

**The reader is not deterministic.** `.gitignore` keeps each board's
`ocr_*.json`, `extracted.json` and `review.txt` on purpose: the overrides file
names dropped and reassigned markers against exactly those reads, and re-running
tesseract renumbers them. A16 lost four reviewed markers and gained fourteen
unreviewed ones by having this skipped once. Add the same stanza for a new board.

**Storage keys are versioned and unit-scoped** (`fluke5700a.testlog.v2`,
`.notes.v2`, `.units.v1`, …). Everything recorded belongs to one calibrator
identified by its serial; notes and readings are scoped to it so two instruments
on a bench do not contaminate each other. `units.js` must load before `notes.js`
and `testlog.js`, which is why `index.html` orders them that way.

**The overrides files come in two styles.** Some are `json.dump(indent=1)`,
some are `fold_overrides.dumps_compact`. Rewrite a file in the style it
already has (check whether it starts with `{\n "`), and after `dumps_compact`
unescape `\uXXXX` — it turns `Ω` and `§` into escapes.

**A wrong reader position often has the right one in `alternates`.** Each hit
in `.build/<asm>/ocr_*.json` carries its runner-up reads; check those before
measuring by hand, and check the `collision` tier the builder discards.

**Boards with no photograph** set `PHOTO_SRC=""` in `extract_assets.sh` and a
drawing-only entry in `LAYERS`; the app greys out the photo modes itself.
**Boards that cannot be removed on their own** (soldered daughter cards, the
rear panel) carry `"fixed": True` in `META`, which keeps them out of the
instrument-configuration log.

**Ad-hoc `magick -annotate` / `montage` calls need `-font`** — pass
`/System/Library/Fonts/Supplemental/Arial.ttf` or they fail with
"unable to read font". `review_markers.py` already does this.

**zsh does not word-split `$refs`.** Pass a designator list held in a variable
to `review_markers.py --refs` as `${=refs}`, or every name becomes one.

**Subagents must not run `git checkout`, `git restore` or write from
`git show`** while overrides are uncommitted; two did, and each wiped a
board's hand placements. Say so in every brief.

**Test points are hand-placed as a matter of course**, on the board and on every
sheet. On a sheet each test point is written twice — once in the legend table,
once beside the symbol on the net — and the reader prefers the table because it
is cleaner text. A marker pointing at a table row answers a question nobody
asked.

**Not every board has a Chapter 5 procedure.** Those sections run §5-4 to §5-23
and stop at A18; A17, A19, A20 and A21 have none. For those, the §5-2 diagnostic
fault codes *are* the published procedure and are curated into
`<asm>.reference.json` as `faultCodes`. Set `procedure` to `None` in the config
rather than emitting an empty shell.

## The manuals live outside the repo

`build_data.py` and `extract_assets.sh` both resolve sources as
`DOCS = dirname(repo_root)`, expecting `Manuals/`, `Schematics_and_Parts_Lists/`
and `Photos/` as siblings of this directory. Nothing under `tools/` takes a path
argument for them.

That resolution breaks anywhere the repository is checked out somewhere its
parent is not the documents directory — a git worktree being the usual case.
Symlinking `Manuals`, `Schematics_and_Parts_Lists` and `Photos` next to the
working copy is enough; check they resolve before running the pipeline.

## The skill

`.claude/skills/add-assembly/` is the authority for anything touching the
pipeline, and it is versioned in this repo on purpose. It carries the seven-step
sequence with its gates, `references/page-map.md` (every one of the 25
assemblies: locator page, schematic sheets, parts table, and how far each column
can be trusted) and `references/pitfalls.md` (every failure this pipeline has
actually produced, grouped by stage). Read the page map before extracting
anything and the pitfalls before reviewing positions.
