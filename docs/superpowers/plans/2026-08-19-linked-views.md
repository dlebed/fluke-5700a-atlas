# Linked Views (Leader/Follower) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A leader window can open view-only follower windows that mirror its assembly/selection/highlights while keeping their own zoom, pan, display and sheet — board on one monitor, schematic on the other.

**Architecture:** A new `js/sync.js` IIFE publishes the leader's navigation state to one localStorage key per link id and applies it in followers (500 ms poll as the correctness mechanism, the `storage` event as an accelerator). Followers are the same page detected via `?follow=<id>`, with a `body.follower` class hiding all recording/navigation chrome. All application of remote state routes through the app's existing `gotoAssembly()`/`select()` paths so sheet-turning, focusing and card behaviour come for free.

**Tech Stack:** Plain ES5 IIFE (var/function/string concat — **no** let/const/arrows/template literals), localStorage + sessionStorage, no build step, must work from `file://`.

**Spec:** `docs/superpowers/plans/2026-08-19-linked-views-spec.md` — read it first; this plan implements it exactly.

## Global Constraints

- Standalone HTML opened straight from disk: no npm, no modules, no network. `js/*.js` are ES5 IIFEs hanging one global off `window`.
- Never call `localStorage.clear()`; never delete a key your code did not create. The service log lives in localStorage.
- Never write into any `test-logs/` directory (real service records).
- `data/*.js` and `data/*.coords.json` are generated — never edit.
- Comment style: prose sentences stating constraints the code cannot show, in the file's existing voice; never narrate a change.
- Node harnesses live under `$TMPDIR`, never in the repo. There is no test runner; `node tools/check_data.js a18` must pass after every task.
- Storage keys are versioned: the sync key is `fluke5700a.sync.v1.<linkId>`.
- Work on branch `ux-review-improvements`. Commit at the end of every task.

## Reference anchors (verified against the current tree)

| Thing | Where |
|---|---|
| `App.start` / URL params / author flag | `js/app.js:62`, `:89`, `:90` (`params.get('author')`), `:99` (`assembly` param) |
| `gotoAssembly(id, ref)` | `js/app.js:318` |
| `onKeyDown` (typing guard, Escape, mode map, `1-6`, `z`, `s`) | `js/app.js:708-760` |
| `setMode` / `setDisplay` | `js/app.js:762`, `:851` |
| `refresh()` / `select(ref, opts)` / `hideCard()` | `js/app.js:1011`, `:1184`, `:1361` |
| `showOnSchematic(ref)` (used by the `s` key) | grep `function showOnSchematic` in `js/app.js` |
| Exposed App API pattern (`App.refresh`, `App.esc`, …) | `js/app.js` bottom, near `global.App = App` |
| Stage bottom bar + Fit button | `index.html:87-106` |
| Script load order | `index.html` `<script>` list; `registry.js` first of the engine, `app.js` last before data |
| Event bus | `js/registry.js` — `BE.on(event, fn)`, `BE.emit`, `BE.set` (diffs, then emits `'state'` with the changed key names) |
| Existing store `storage`-event listeners (pattern to copy) | `js/testlog.js` — grep `addEventListener('storage'` |

---

### Task 1: `js/sync.js` core — id, key, payload, decision logic

**Files:**
- Create: `js/sync.js`
- Test: `$TMPDIR/sync-harness.js` (not committed)

**Interfaces:**
- Consumes: `window.BoardExplorer` (bus + state), `window.sessionStorage`, `window.localStorage`.
- Produces (used by Tasks 2–4): global `Sync` with
  `Sync.init(hooks)` where `hooks = { gotoAssembly: fn(id, ref), select: fn(ref, opts), showOnSchematic: fn(ref), refresh: fn(), draw: fn() }`;
  `Sync.isFollower()` → boolean; `Sync.openFollower(display)` (leader only);
  internals exposed for the harness: `Sync._payload()`, `Sync._decode(raw)`, `Sync._linkId()`.

- [ ] **Step 1: Write the failing harness**

Write `$TMPDIR/sync-harness.js`:

```js
// Harness for js/sync.js pure logic. Run: node $TMPDIR/sync-harness.js
var fs = require('fs'), vm = require('vm');
var repo = '/Users/dlebed/Documents/HW/Fluke/Calibrator/5700a/fluke-5700a-atlas';

function makeStore() {
  var m = {};
  return {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null; },
    setItem: function (k, v) { m[k] = String(v); },
    removeItem: function (k) { delete m[k]; },
    _m: m
  };
}

function boot(search) {
  var ctx = { console: console, setInterval: function () { return 0; }, clearInterval: function () {} };
  ctx.window = ctx; ctx.global = ctx;
  ctx.location = { search: search || '' };
  ctx.localStorage = makeStore();
  ctx.sessionStorage = makeStore();
  ctx.addEventListener = function () {};
  ctx.open = function (url) { ctx._opened = url; return {}; };
  ctx.URLSearchParams = URLSearchParams;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(repo + '/js/registry.js', 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(repo + '/js/sync.js', 'utf8'), ctx);
  return ctx;
}

var pass = 0, fail = 0;
function ok(cond, name) { if (cond) { pass++; } else { fail++; console.log('FAIL: ' + name); } }

// -- link id: stable within a tab, absent until leading ---------------------
var L = boot('');
L.BoardExplorer.state.assembly = { id: 'A18' };
L.Sync.init({});
ok(!L.Sync.isFollower(), 'no follow param means leader');
var id1 = L.Sync._linkId();
ok(typeof id1 === 'string' && id1.length >= 6, 'leader mints a link id');
ok(L.Sync._linkId() === id1, 'link id is stable across calls');
ok(L.sessionStorage.getItem('fluke5700a.sync.leaderId') === id1, 'id survives reload via sessionStorage');

// -- payload ----------------------------------------------------------------
L.BoardExplorer.state.selected = 'C13';
L.BoardExplorer.state.highlighted = ['C13', 'C14'];
var p = L.Sync._payload();
ok(p.v === 1 && p.asm === 'A18' && p.sel === 'C13', 'payload carries v/asm/sel');
ok(p.hi.length === 2 && p.hi[1] === 'C14', 'payload carries highlights');
ok(typeof p.seq === 'number', 'payload carries a sequence number');

// -- decode: garbage never throws -------------------------------------------
ok(L.Sync._decode('{"v":1,"seq":3,"asm":"A18","sel":null,"hi":[]}').seq === 3, 'decode valid');
ok(L.Sync._decode('not json') === null, 'decode garbage is null');
ok(L.Sync._decode('{"v":99,"seq":1}') === null, 'decode wrong version is null');
ok(L.Sync._decode(null) === null, 'decode absent is null');

// -- follower detection ------------------------------------------------------
var F = boot('?assembly=A18&follow=abc123&display=schematic');
ok(F.Sync.isFollower(), 'follow param means follower');
ok(F.Sync._linkId() === 'abc123', 'follower link id comes from the URL');

// -- leader publish / follower apply round-trip -----------------------------
var applied = [];
F.localStorage = L.localStorage;   // share one store, like two real windows
F.Sync.init({
  gotoAssembly: function (a, r) { applied.push(['goto', a, r]); },
  select: function (r) { applied.push(['select', r]); },
  showOnSchematic: function (r) { applied.push(['sheet', r]); },
  refresh: function () {}, draw: function () {}
});
L.BoardExplorer.emit('state', ['selected']);           // leader reacts to bus
var raw = L.localStorage.getItem('fluke5700a.sync.v1.' + id1);
ok(raw !== null, 'leader wrote its sync key on a state change');
// _apply gates on seq, so each staged call below gets a fresh, higher seq --
// what varies between them is the follower's local state, not the gate.
function staged(n) { var p = F.Sync._decode(raw); p.seq = n; return p; }
F.BoardExplorer.state.assembly = { id: 'A14' };        // follower is elsewhere
F.Sync._apply(staged(100));
ok(applied.some(function (x) { return x[0] === 'goto' && x[1] === 'A18' && x[2] === 'C13'; }),
   'assembly mismatch routes through gotoAssembly with the ref');
applied.length = 0;
F.BoardExplorer.state.assembly = { id: 'A18' };
F.BoardExplorer.state.selected = 'C2';
F.Sync._apply(staged(101));
ok(applied.some(function (x) { return x[0] === 'select' && x[1] === 'C13'; }),
   'same assembly, different part routes through select');
applied.length = 0;
F.BoardExplorer.state.selected = 'C13';
F.Sync._apply(staged(102));
ok(!applied.some(function (x) { return x[0] === 'select'; }),
   'a payload matching local state does not reselect');

// -- seq gating -------------------------------------------------------------
ok(F.Sync._shouldApply({ v: 1, seq: 5 }) === true, 'new seq applies');
F.Sync._markApplied({ v: 1, seq: 5 });
ok(F.Sync._shouldApply({ v: 1, seq: 5 }) === false, 'same seq is skipped');
ok(F.Sync._shouldApply({ v: 1, seq: 6 }) === true, 'higher seq applies');

console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node $TMPDIR/sync-harness.js`
Expected: crash — `Cannot find module .../js/sync.js` (or `Sync is not defined`).

- [ ] **Step 3: Write `js/sync.js`**

```js
/*
 * sync.js — linked views: one leader window, any number of followers.
 *
 * The leader is the ordinary app; a follower is the same page opened with
 * ?follow=<id>, showing only the stage and applying the leader's navigation
 * — assembly, selection, highlights — while keeping its own zoom, pan,
 * display and sheet. State crosses windows through one localStorage key per
 * link. Followers poll it, because the storage event is not guaranteed to
 * fire between file:// windows in every browser; where it does fire it only
 * makes the poll's answer arrive sooner. The event never fires in the
 * window that wrote, and the leader never reads the key, so there is no
 * echo path to guard against.
 */
(function (global) {
  'use strict';

  var BE = global.BoardExplorer;
  var KEY_PREFIX = 'fluke5700a.sync.v1.';
  var LEADER_ID_KEY = 'fluke5700a.sync.leaderId';
  var POLL_MS = 500;

  var hooks = {};
  var follower = false;
  var linkId = null;
  var seq = 0;
  var lastApplied = 0;

  function param(name) {
    // URLSearchParams exists everywhere this app runs; kept in one place
    // in case a follower URL is ever built by hand with an empty value.
    var p = new global.URLSearchParams(global.location.search);
    var v = p.get(name);
    return v && v.trim() ? v.trim() : null;
  }

  /**
   * One id per leader tab: sessionStorage survives a reload of the same
   * tab, so followers re-attach after the leader refreshes, but is never
   * shared with another tab, so two benches never cross-talk.
   */
  function ensureLeaderId() {
    var id = null;
    try { id = global.sessionStorage.getItem(LEADER_ID_KEY); } catch (err) { /* in-memory */ }
    if (!id) {
      id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      try { global.sessionStorage.setItem(LEADER_ID_KEY, id); } catch (err) { /* in-memory */ }
    }
    return id;
  }

  function payload() {
    seq += 1;
    return {
      v: 1,
      seq: seq,
      asm: BE.state.assembly ? BE.state.assembly.id : null,
      sel: BE.state.selected || null,
      hi: (BE.state.highlighted || []).slice()
    };
  }

  function decode(raw) {
    if (!raw) return null;
    var p;
    try { p = JSON.parse(raw); } catch (err) { return null; }
    if (!p || p.v !== 1 || typeof p.seq !== 'number') return null;
    return p;
  }

  function publish() {
    try {
      global.localStorage.setItem(KEY_PREFIX + linkId, JSON.stringify(payload()));
    } catch (err) { /* a full store already alarms elsewhere; navigation sync just pauses */ }
  }

  function shouldApply(p) { return !!p && p.seq > lastApplied; }
  function markApplied(p) { lastApplied = p.seq; }

  function apply(p) {
    if (!shouldApply(p)) return;
    markApplied(p);
    var here = BE.state.assembly ? BE.state.assembly.id : null;
    if (p.asm && p.asm !== here) {
      if (hooks.gotoAssembly) hooks.gotoAssembly(p.asm, p.sel || undefined);
    } else if (p.sel && p.sel !== BE.state.selected) {
      if (hooks.select) hooks.select(p.sel, { focus: true });
    } else if (!p.sel && BE.state.selected) {
      BE.set({ selected: null });
    }
    // A follower sitting on the schematic reads along: it turns to the
    // selected part's sheet the same way the s key would.
    if (p.sel && BE.state.display === 'schematic' && hooks.showOnSchematic) {
      hooks.showOnSchematic(p.sel);
    }
    BE.set({ highlighted: p.hi || [] });
    if (hooks.refresh) hooks.refresh();
    if (hooks.draw) hooks.draw();
  }

  function readAndApply() {
    apply(decode(safeGet(KEY_PREFIX + linkId)));
  }

  function safeGet(k) {
    try { return global.localStorage.getItem(k); } catch (err) { return null; }
  }

  var Sync = {
    // Computed from the URL, not from init state: App.start asks this while
    // setting the body class, before it has the hooks to hand over.
    isFollower: function () { return !!param('follow'); },

    init: function (h) {
      hooks = h || {};
      follower = Sync.isFollower();
      linkId = follower ? param('follow') : ensureLeaderId();
      if (follower) {
        // The stored value is the leader's latest word; a follower opened
        // late, or reloaded, starts from it rather than from nothing.
        readAndApply();
        global.setInterval(readAndApply, POLL_MS);
        global.addEventListener('storage', function (e) {
          if (e && e.key === KEY_PREFIX + linkId) readAndApply();
        });
      } else {
        BE.on('state', function (changed) {
          for (var i = 0; i < changed.length; i++) {
            if (changed[i] === 'assembly' || changed[i] === 'selected' ||
                changed[i] === 'highlighted') { publish(); return; }
          }
        });
      }
    },

    /** Leader only: open one follower window on the given display. */
    openFollower: function (display) {
      var here = BE.state.assembly ? BE.state.assembly.id : '';
      var url = 'index.html?assembly=' + encodeURIComponent(here) +
        '&follow=' + encodeURIComponent(linkId) +
        (display ? '&display=' + encodeURIComponent(display) : '');
      publish();          // so the new window has a snapshot to bootstrap from
      global.open(url, '_blank');
    },

    /* exposed for the node harness */
    _payload: payload,
    _decode: decode,
    _apply: apply,
    _shouldApply: shouldApply,
    _markApplied: markApplied,
    _linkId: function () { return linkId; }
  };

  global.Sync = Sync;
})(window);
```

- [ ] **Step 4: Run the harness to verify it passes**

Run: `node $TMPDIR/sync-harness.js`
Expected: `20 passed, 0 failed` (exit 0). If a specific check fails, fix `js/sync.js`, not the check — each check states spec behaviour.

- [ ] **Step 5: Syntax and ES5 gates**

Run: `node -e "new Function(require('fs').readFileSync('js/sync.js','utf8'))"`
Run: `grep -nE "=>|\\blet\\b|\\bconst\\b|\\\`" js/sync.js` — expected: no output.
Run: `node tools/check_data.js a18` — expected: pass.

- [ ] **Step 6: Commit**

```bash
git add js/sync.js
git commit -m "Linked views: sync module (leader publish, follower apply)"
```

---

### Task 2: Leader wiring — script tag, button, App hooks

**Files:**
- Modify: `index.html` (script list; stage-controls at lines 87–106)
- Modify: `js/app.js` (`App.start` at :62; the action/button wiring near the Fit button handler — grep `fitBtn`)

**Interfaces:**
- Consumes: `Sync.init(hooks)`, `Sync.openFollower(display)`, `Sync.isFollower()` from Task 1.
- Produces: `Sync` is initialised on every page load with real hooks; a `#linked-view-btn` button exists in the stage bottom bar.

- [ ] **Step 1: Load sync.js**

In `index.html`, add `<script src="js/sync.js"></script>` immediately **after** `<script src="js/registry.js"></script>` (it needs the bus; app.js calls into it later).

- [ ] **Step 2: Add the button**

In `index.html` stage-controls, before the Fit button (line ~105):

```html
<button class="ghost" id="linked-view-btn"
        title="Open a view-only window that follows this one">⧉ Linked view</button>
```

- [ ] **Step 3: Initialise Sync and wire the button in app.js**

In `App.start`, after `selectAssembly(initial.id);` (so the first publish has real state), add:

```js
    if (global.Sync) {
      global.Sync.init({
        gotoAssembly: gotoAssembly,
        select: select,
        showOnSchematic: showOnSchematic,
        refresh: refresh,
        draw: function () { viewer.draw(); }
      });
    }
```

In `wireEvents()`, next to the `fitBtn` click handler, add:

```js
    var linkedBtn = document.getElementById('linked-view-btn');
    if (linkedBtn) {
      linkedBtn.addEventListener('click', function () {
        // A follower opens on the schematic by default: the common bench
        // shape is board here, schematic on the other monitor.
        global.Sync.openFollower('schematic');
        toast('Linked view opened — it follows this window');
      });
    }
```

- [ ] **Step 4: Manual verification (served)**

Run: `python3 -m http.server 8123` in the repo, open `http://127.0.0.1:8123/index.html?assembly=A18`.
- Click **⧉ Linked view** → a second window opens with `follow=` and `display=schematic` in its URL. (It still shows full chrome — Task 4 hides it.)
- In the leader, search `C13` and select it → within ~½ s the follower turns to C13's sheet with C13 selected.
- Switch the leader to A14 → the follower switches to A14.
- Zoom the follower in; select another part in the leader → the follower pans at **its own** zoom (or doesn't move if the part is on screen), never re-fitting.
- In the follower, select some other part locally → the **leader must not move** (one-way).

- [ ] **Step 5: Gates and commit**

Run: `node -e "new Function(require('fs').readFileSync('js/app.js','utf8'))"` and `node tools/check_data.js a18` — both pass.

```bash
git add index.html js/app.js
git commit -m "Linked views: leader wiring and the open button"
```

---

### Task 3: Follower behaviour — chrome, keys, display param, author guard

**Files:**
- Modify: `js/app.js` (`App.start` :62–101, `onKeyDown` :708)
- Modify: `css/app.css` (append a `/* ---- linked follower windows ---- */` section)

**Interfaces:**
- Consumes: `Sync.isFollower()`.
- Produces: `body.follower` class; follower keyboard whitelist; `display` URL param honoured.

- [ ] **Step 1: Follower flags in App.start**

At `js/app.js:90`, the author flag must lose to follower mode, and the body class must be set before anything renders. Replace the line `BE.state.author = params.get('author') === '1';` with:

```js
    var following = global.Sync && global.Sync.isFollower && global.Sync.isFollower();
    // A follower is a window you look at, not one you work in: Author Mode
    // in it would mean two writers over one edit store, which is a
    // different feature and explicitly not this one.
    BE.state.author = params.get('author') === '1' && !following;
    if (following) document.body.classList.add('follower');
```

- [ ] **Step 2: Honour the display param**

In `App.start`, immediately after `selectAssembly(initial.id);`, add:

```js
    var wantedDisplay = (params.get('display') || '').toLowerCase();
    if (following && /^(drawing|photo|overlay|swipe|schematic|split)$/.test(wantedDisplay)) {
      setDisplay(wantedDisplay);
    }
```

(`setDisplay` at :851 already refuses photo-needing displays on boards with no alignment, so a bad param degrades safely.)

- [ ] **Step 3: Keyboard whitelist**

At the very top of `onKeyDown` (:708), before the typing guard, add:

```js
    if (document.body.classList.contains('follower')) {
      // A follower owns its view and nothing else: displays, fit, and
      // putting the card away. Everything that navigates or records
      // belongs to the leader.
      var displays2 = ['drawing', 'photo', 'overlay', 'swipe', 'schematic', 'split'];
      if (/^[1-6]$/.test(e.key)) { setDisplay(displays2[+e.key - 1]); }
      else if (e.key.toLowerCase() === 'z') { fitAll(); }
      else if (e.key === 'Escape') { pinned = false; hideCard(); }
      return;
    }
```

- [ ] **Step 4: Follower chrome in CSS**

Append to `css/app.css`:

```css
/* ---- linked follower windows ----------------------------------------------
 *
 * A follower is the stage and nothing else: the panel, search, pickers and
 * mode tabs all act on the record, and the record belongs to the leader.
 * The bottom strip stays because display, sheet and fit are choices each
 * window makes for itself; the info card stays because a part's data sheet
 * is what the second monitor is for.
 */
body.follower .panel,
body.follower .search,
body.follower .assembly-picker,
body.follower .modes,
body.follower .detail-dock { display: none; }
body.follower .stage { flex: 1 1 100%; }
```

Then check the topbar visually: with search/pickers/tabs hidden the brand mark sits alone. If the bar looks derelict rather than quiet, add a static assembly label — in `renderZoneFrame` or the statusbar there is already an assembly title (`#status-left` carries "A18 Filter/PA Supply PCA…"), which the follower keeps; prefer leaving the topbar minimal over inventing new chrome.

- [ ] **Step 5: Manual verification (served)**

Reload leader and follower from Task 2's setup:
- Follower shows only: topbar brand, stage, bottom display strip, status bar. No panel, no dock, no search, no mode tabs, no Author tab.
- `?author=1&follow=…` in one URL → no Author tab, no editing (author ignored).
- In the follower press `1`–`6` (displays change), `z` (fit), `Esc` (card hides, **leader's selection unaffected**), then `b`, `t`, `/`, `s`, `a`, `d` — all inert.
- Select a part in the leader with the follower's card hidden → the card comes back with the new part (selection replaces the local hide).
- Record a reading in the leader (unit with a session) → follower's marker verdict colour updates within a second or two (cross-tab store listeners; give it one poll tick).

- [ ] **Step 6: Manual verification (file://)**

Open `index.html?assembly=A18` directly from disk (double-click), click ⧉ Linked view.
- Same checks as Step 5; sync may ride the 500 ms poll instead of the storage event — selection must still arrive.
- If the browser blocks `window.open` from file://, allow the popup once and re-test; note actual behaviour in the commit message if it deviates.

- [ ] **Step 7: Gates and commit**

Run: syntax gate on `js/app.js`, `node tools/check_data.js a18`, `node tools/check_data.js a17` — pass.

```bash
git add js/app.js css/app.css
git commit -m "Linked views: follower chrome, keys and display param"
```

---

### Task 4: Regression sweep and docs

**Files:**
- Modify: `README.md` (add a "Linked views" subsection under *What it does*; add `⧉` to the keyboard table's context if needed)
- Test: full sweep, both origins

**Interfaces:**
- Consumes: everything above.
- Produces: a documented, regression-checked feature.

- [ ] **Step 1: README**

Under *What it does*, after the "Look at it however helps" paragraph, add (adjust to taste, keep the README's voice):

```markdown
**Put the schematic on the other monitor.** *⧉ Linked view* opens a view-only
window that follows this one: same board, same selected part, same search
hits, its own zoom and its own display — so the board sits on one screen and
the schematic turns its own pages on the other. Followers never record;
readings taken in the main window colour their markers as they land. The
link survives a reload on either side, and two main windows never share
followers.
```

- [ ] **Step 2: Full regression sweep**

```bash
for f in js/*.js; do node -e "new Function(require('fs').readFileSync('$f','utf8'))" || echo "FAIL $f"; done
for a in a4 a5 a6 a7 a8 a9 a10 a11 a12 a13 a14 a15 a16 a17 a18 a19 a20; do node tools/check_data.js $a >/dev/null || echo "FAIL $a"; done
node $TMPDIR/sync-harness.js
```

Expected: no FAIL lines; harness green.

- [ ] **Step 3: Non-follower regression (leader must be unchanged for normal use)**

In a normal (no `follow=`) served window: search, select, record a reading, switch modes with B/T/L/P/F/R, switch displays 1–6, open Author Mode with `?author=1` — all behave exactly as before. The only visible additions are the ⧉ button and (harmlessly) the sync key writes.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "Linked views: document the feature"
```

---

## Self-review notes (already applied)

- Spec coverage: leader button/id semantics (Task 2 Step 3, Task 1 `ensureLeaderId`), follower whitelist apply (Task 1 `apply`), poll+event transport (Task 1 `init`), chrome-less layout (Task 3 Step 4), keys (Task 3 Step 3), author exclusion (Task 3 Step 1), file:// verification (Task 3 Step 6), live verdict colours (Task 3 Step 5 last bullet). Deselect (leader clears selection) is handled by the `!p.sel && BE.state.selected` branch.
- Type consistency: `Sync.init(hooks)` hook names match between Task 1's module and Task 2's call site; `openFollower('schematic')` matches the URL param consumed in Task 3 Step 2; `fitAll` and `hideCard`/`pinned` exist at the cited lines.
- Known judgement calls left to the implementer: whether the empty follower topbar needs a static label (Task 3 Step 4 gives the decision rule); exact popup behaviour from `file://` varies by browser and is to be recorded, not fought.
