/*
 * check_data.js — integrity checks over a built dataset.
 *
 * These are the mistakes that would quietly mislead someone at the bench: a
 * test point that references a COM point which does not exist, an expectation
 * with no citation back to the manual, a procedure that names a part the board
 * does not have. Run after any rebuild.
 *
 *   node tools/check_data.js [assembly-id]
 */

const fs = require('fs');
const path = require('path');

const root = path.dirname(__dirname);
const asm = (process.argv[2] || 'a18').toLowerCase();

const problems = [];
const notes = [];

function fail(msg) { problems.push(msg); }
function note(msg) { notes.push(msg); }

const text = fs.readFileSync(path.join(root, 'data', `${asm}.js`), 'utf8');
const data = JSON.parse(text.slice(text.indexOf('register(') + 9, text.lastIndexOf(');')));

const byRef = new Map();
const all = [...(data.components || []), ...(data.testpoints || [])];

// --- designators are unique -------------------------------------------------
for (const item of all) {
  if (byRef.has(item.ref)) fail(`duplicate designator ${item.ref}`);
  byRef.set(item.ref, item);
}

// --- test points ------------------------------------------------------------
for (const tp of data.testpoints || []) {
  if (tp.refPoint && !byRef.has(tp.refPoint)) {
    fail(`${tp.ref} references ${tp.refPoint} as its COM point, which does not exist`);
  }
  if (tp.refPoint === tp.ref) fail(`${tp.ref} references itself as its COM point`);

  if (tp.noPublishedValue && (tp.nominal != null || tp.maxAbs != null)) {
    fail(`${tp.ref} is marked noPublishedValue but carries an expected value`);
  }
  const states = tp.states || (tp.isReturn ? [] : [tp]);
  for (const st of states) {
    const named = st.label ? `${tp.ref} (${st.label})` : tp.ref;
    const hasExpectation =
      st.nominal != null || st.maxAbs != null;
    // A point can legitimately have no expected value: A17's TP51-TP65 are
    // logic lines the manuals never tabulate. That has to be declared rather
    // than left implicit, so an accidentally missing nominal still fails.
    if (!tp.isReturn && !tp.noPublishedValue && !hasExpectation) {
      fail(`${named} has no nominal and no ceiling`);
    }
    if (st.nominal != null && st.tolerance == null &&
        st.tolerancePct == null && st.maxAbs == null) {
      fail(`${named} has a nominal of ${st.nominal} but no tolerance`);
    }
    if (hasExpectation && !st.source && !tp.source) {
      fail(`${named} states an expected value with no citation`);
    }
    for (const ref of st.onFail || []) {
      if (!byRef.has(ref)) fail(`${named} tells you to check ${ref}, which is not on this board`);
    }
  }
  if (tp.isReturn && (tp.nominal != null || tp.states)) {
    fail(`${tp.ref} is marked as a return but also carries an expected value`);
  }
}

// --- probe points -----------------------------------------------------------
for (const p of data.probePoints || []) {
  if (p.component && !byRef.has(p.component)) {
    fail(`probe point ${p.id} is on ${p.component}, which is not on this board`);
  }
  if (p.refPoint && !byRef.has(p.refPoint)) {
    fail(`probe point ${p.id} references ${p.refPoint}, which does not exist`);
  }
  if (!p.source) fail(`probe point ${p.id} has no citation`);
}

// --- procedures and fault codes ---------------------------------------------
for (const proc of data.procedures || []) {
  for (const step of proc.steps || []) {
    for (const ref of step.refs || []) {
      // U201A..D are comparator sections, not separate designators.
      if (!byRef.has(ref) && !/^U\d+[A-D]$/.test(ref)) {
        fail(`${proc.id} step ${step.n} names ${ref}, which is not on this board`);
      }
    }
  }
}
for (const code of data.faultCodes || []) {
  for (const ref of code.refs || []) {
    if (!byRef.has(ref)) fail(`fault ${code.code} names ${ref}, which is not on this board`);
  }
  if (!code.verdict) fail(`fault ${code.code} has no interpretation`);
}

// --- rails ------------------------------------------------------------------
for (const [id, rail] of Object.entries(data.rails || {})) {
  if (rail.com && !byRef.has(rail.com)) {
    fail(`rail ${id} uses ${rail.com} as its COM point, which does not exist`);
  }
  for (const [group, refs] of Object.entries(rail.circuit || {})) {
    if (!Array.isArray(refs)) continue;
    for (const ref of refs) {
      if (typeof ref === 'string' && /^[A-Z]+\d+$/.test(ref) && !byRef.has(ref)) {
        fail(`rail ${id} lists ${ref} under ${group}, which is not on this board`);
      }
    }
  }
}

// --- geometry ---------------------------------------------------------------
let placed = 0, verified = 0, sch = 0, notOnDrawing = 0;
for (const item of all) {
  if (item.notOnDrawing) notOnDrawing++;
  if (item.board) {
    placed++;
    const { x, y } = item.board;
    if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1)) {
      fail(`${item.ref} sits outside the board image at ${x}, ${y}`);
    }
  } else if (!item.notOnDrawing) {
    note(`${item.ref} has no board position`);
  }
  if (item.verified) verified++;
  for (const occurrence of item.sch || []) {
    sch++;
    if (!(data.schematics || []).some((s) => s.id === occurrence.sheet)) {
      fail(`${item.ref} claims to be on sheet ${occurrence.sheet}, which does not exist`);
    }
  }
}

// --- one marker sitting entirely inside another -----------------------------
// Two parts do not occupy the same board area, so a marker wholly contained in
// another marker is almost always one of them being in the wrong place. The
// reader's own collision check cannot see this: it compares centres, so a small
// box well inside a large one, off to one side, passes it cleanly.
//
// The exception is real and worth allowing for: a physically large part -- a
// transformer, a big can, a hybrid -- covers enough board that a neighbouring
// marker can legitimately fall inside its outline. So this reports rather than
// fails, and says how big the container is, because a resistor inside a
// resistor is a bug while a resistor inside T1 may not be.
const containment = [];

function boxesFor(space) {
  const out = [];
  for (const it of all) {
    if (space === 'board') {
      if (it.board && it.board.w && it.board.h) out.push({ ref: it.ref, g: it.board });
    } else {
      for (const o of it.sch || []) {
        if (o.sheet === space && o.w && o.h) out.push({ ref: it.ref, g: o });
      }
    }
  }
  return out.map((b) => ({
    ref: b.ref,
    x0: b.g.x - b.g.w / 2, x1: b.g.x + b.g.w / 2,
    y0: b.g.y - b.g.h / 2, y1: b.g.y + b.g.h / 2,
    area: b.g.w * b.g.h,
  }));
}

const spaces = ['board', ...(data.schematics || []).map((s) => s.id)];
for (const space of spaces) {
  const boxes = boxesFor(space);
  if (boxes.length < 2) continue;
  const areas = boxes.map((b) => b.area).sort((a, b) => a - b);
  const medianArea = areas[Math.floor(areas.length / 2)];
  for (const inner of boxes) {
    for (const outer of boxes) {
      if (inner.ref === outer.ref) continue;
      const inside = inner.x0 >= outer.x0 && inner.x1 <= outer.x1 &&
                     inner.y0 >= outer.y0 && inner.y1 <= outer.y1;
      if (!inside) continue;
      containment.push({
        space, inner: inner.ref, outer: outer.ref,
        ratio: outer.area / (inner.area || 1e-9),
        // Reported, not filtered: a large container makes containment possible,
        // it does not make it correct. Every one of these gets looked at.
        outerIsLarge: outer.area > medianArea * 6,
      });
    }
  }
}

// --- report -----------------------------------------------------------------
console.log(`${data.id} ${data.name} — PCA ${data.pca} rev ${data.rev}`);
console.log(`  ${all.length} items: ${data.components.length} parts, ` +
            `${data.testpoints.length} test points, ${(data.probePoints || []).length} probe points`);
console.log(`  ${placed} placed on the board, ${verified} checked by hand, ` +
            `${notOnDrawing} with no silkscreen, ${sch} schematic occurrences`);
console.log(`  ${(data.faultCodes || []).length} fault codes, ` +
            `${(data.procedures || []).reduce((n, p) => n + p.steps.length, 0)} procedure steps`);

if (notes.length) {
  console.log(`\n${notes.length} items still unplaced:`);
  console.log('  ' + notes.map((n) => n.split(' ')[0]).join(' '));
}

if (containment.length) {
  console.log(`\n${containment.length} marker(s) sit entirely inside another — review each:`);
  for (const c of containment.sort((a, b) => a.ratio - b.ratio)) {
    console.log(`  ${c.outerIsLarge ? '·' : '⚠'} ${c.space}: ${c.inner} inside ${c.outer} ` +
                `(${c.ratio.toFixed(1)}x its area)` +
                (c.outerIsLarge ? ' — outer is a large part, so possible' : ''));
  }
}

if (problems.length) {
  console.log(`\n${problems.length} PROBLEM(S):`);
  for (const p of problems) console.log('  ✘ ' + p);
  process.exit(1);
}
console.log('\nAll integrity checks passed.');
