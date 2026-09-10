/*
 * app.js — wiring: display modes, panels, the info card and the keyboard.
 */
(function (global) {
  'use strict';

  var BE = global.BoardExplorer;
  var TP = global.TestPoints;
  var Log = global.TestLog;
  var Notes = global.Notes;
  var Proc = global.Procedures;
  var Search = global.Search;
  var Units = global.Units;
  var Parts = global.Parts;
  var Service = global.Service;

  // The display modes, in the order of the 1-6 keys and of the tab strip. The
  // leader's keyboard, a follower's whitelist and the display URL param all
  // read this one list, because a seventh mode added to two of the three
  // fails silently in the third.
  var DISPLAYS = ['drawing', 'photo', 'overlay', 'swipe', 'schematic', 'split'];

  var el = {};
  var viewer = null;
  var secondary = null;
  var pinned = false;
  var activeStep = null;
  var stateIndex = 0;
  // Set by a save so the rebuild it causes can put the caret back in the
  // measurement box; see renderDetailDock.
  var measureWantsFocus = false;
  var swipeFraction = 0.5;
  var activeKind = null;   // component type filter from the legend
  // Values typed into a procedure step, kept across the re-render that
  // recording one of them causes.
  var procEntries = {};    // 'step/ref' -> what is in the box
  var procState = {};      // 'step/ref' -> chosen operating mode
  var procRecorded = {};   // 'step/ref' -> already written to the log
  var measureQuantity = null;   // which quantity the component box is set to
  var measureQuantityRef = null; // and the part it was chosen for
  var pendingRepair = null;     // {ref, status} while the repair form is open
  var serviceFilter = null;     // 'faulty' | 'replaced' | 'measured' | 'noted'
  var suppressLogRefresh = false; // a meta edit is writing; the form must stand
  // A pin count corrected by hand, and the values already typed under it, held
  // only until the sweep is saved. Once saved the count travels on the reading
  // itself, which is what the next sweep of that part reads its default from.
  var pendingPinRef = null;
  var pendingPinCount = null;
  var pendingPinValues = null;
  // A mouse button is held down, and a grid resize that is waiting for it to
  // come up. Nothing above a button may change size in that window: a control
  // that moves between the press and the release is never clicked.
  var mouseIsDown = false;
  var pinRegrid = null;

  var DOCK_KEY = 'fluke5700a.detaildock.collapsed';   // the old two-state key
  var DOCK_FOLD_KEY = 'fluke5700a.detaildock.fold.v1';
  var DOCK_H_KEY = 'fluke5700a.detaildock.height';
  var MIN_LIST_H = 140;    // the parts list stays usable no matter what
  var MIN_DOCK_H = 90;     // enough for the header and one row under it
  // How far the dock is folded. 'measure' is the stop a rail sweep wants: the
  // box, the limits and the band, with the notes and the history out of the
  // way -- and the dock only as tall as those.
  var DOCK_FOLDS = ['full', 'measure', 'collapsed'];
  var dockFold = 'full';
  var dockHeight = 0;      // 0 = auto, i.e. the CSS cap
  try {
    // The old boolean is still read, once: a dock left collapsed before the
    // middle stop existed should come back collapsed, not wide open.
    var storedFold = global.localStorage.getItem(DOCK_FOLD_KEY);
    dockFold = DOCK_FOLDS.indexOf(storedFold) >= 0 ? storedFold
      : (global.localStorage.getItem(DOCK_KEY) ? 'collapsed' : 'full');
    dockHeight = parseInt(global.localStorage.getItem(DOCK_H_KEY), 10) || 0;
  } catch (err) { /* storage unavailable; start with the defaults */ }

  var App = { };

  /* ================= startup ================= */

  App.start = function () {
    ['assembly-select', 'unit-select', 'unit-picker', 'search-input', 'mode-tabs',
     'display-tabs', 'sheet-tabs',
     'opacity-group', 'opacity-slider', 'viewport', 'viewport-secondary', 'infocard',
     'panel-body', 'status-left', 'status-right', 'toast', 'stage', 'zoneframe',
     'coverage-badge', 'fit-btn', 'file-input', 'swipe-divider',
     'detail-dock', 'detail-dock-head', 'detail-dock-body', 'detail-dock-title',
     'detail-dock-toggle', 'detail-dock-close', 'detail-dock-resize',
     'unit-edit'].forEach(function (id) {
      el[id.replace(/-(\w)/g, function (m, c) { return c.toUpperCase(); })] =
        document.getElementById(id);
    });

    var datasets = BE.list();
    if (!datasets.length) {
      el.panelBody.innerHTML = '<div class="empty"><strong>No assembly loaded</strong>' +
        'Add a data file to index.html.</div>';
      return;
    }

    datasets.forEach(function (d) {
      var opt = document.createElement('option');
      opt.value = d.id;
      opt.textContent = d.id + ' — ' + d.name;
      el.assemblySelect.appendChild(opt);
    });

    var params = new URLSearchParams(location.search);
    var following = global.Sync && global.Sync.isFollower && global.Sync.isFollower();
    // A follower is a window you look at, not one you work in: Author Mode
    // in it would mean two writers over one edit store, which is a
    // different feature and explicitly not this one.
    BE.state.author = params.get('author') === '1' && !following;
    if (following) {
      document.body.classList.add('follower');
      // The topbar loses its pickers, search and mode tabs in a follower,
      // and the status bar's board name sits in small type at the very
      // bottom of a screen meant to be read from across a bench. A second,
      // quieter name up top -- kept current by renderStatus, never a control
      // -- is worth the duplication. Built here rather than in index.html
      // because that markup does not exist for a normal window at all.
      el.followerAssembly = document.createElement('span');
      el.followerAssembly.className = 'follower-assembly';
      var brand = document.querySelector('.topbar .brand');
      if (brand) brand.parentNode.insertBefore(el.followerAssembly, brand.nextSibling);
    }
    if (BE.state.author) document.body.classList.add('author');
    el.authorTab = document.querySelector('.author-tab');
    syncAuthorTab();

    // An assembly named in the URL is a deliberate request -- someone followed a
    // link to that board -- so it beats what was last open. Only when the query
    // says nothing does the remembered one apply, and a board that has since
    // been removed from the page falls through to the first.
    var wanted = (params.get('assembly') || '').toUpperCase();
    var initial = BE.get(wanted) || BE.get(rememberedAssembly()) || datasets[0];
    el.assemblySelect.value = initial.id;
    rememberAssembly(initial.id);

    viewer = new global.Viewer(el.viewport, {
      onHover: onHover,
      onClick: onClick,
      onPointerDown: function (e, pos, hit) {
        return global.Author && global.Author.onPointerDown(e, pos, hit, viewer);
      },
      onDrag: function (drag, pos) {
        return global.Author && global.Author.onDrag(drag, pos, viewer);
      },
      onPointerUp: function (e, drag) {
        if (global.Author) global.Author.onPointerUp(e, drag, viewer);
      },
      afterDraw: function (ctx, v) {
        if (global.Author) global.Author.afterDraw(ctx, v);
      },
      cursorFor: function (pos, hit, dflt) {
        return global.Author ? global.Author.cursorFor(pos, hit, dflt, viewer) : dflt;
      },
      onTransform: function () { syncSwipeClip(); }
    });
    secondary = new global.Viewer(el.viewportSecondary, {
      // Hover positions arrive relative to the pane that saw the pointer,
      // but the card is placed in stage coordinates tuned to the primary
      // pane. In a split the secondary pane starts half a stage further
      // right, so its positions must carry that offset or the card lands
      // over the other pane, half a screen from the pointer.
      onHover: function (hit, pos) { onHover(hit, secondaryPos(pos)); },
      onClick: onClick
    });

    wireEvents();
    // redisplay is applyDisplay: it re-gates the Photo/Overlay/Swipe buttons,
    // which are disabled until the photo layer has a transform. Author Mode
    // can give it one, and refresh() does not cover those buttons.
    if (global.Author) {
      global.Author.init({ refresh: refresh, toast: toast, redisplay: applyDisplay });
    }
    Units.ensure();
    renderUnitPicker();
    selectAssembly(initial.id);

    var wantedDisplay = (params.get('display') || '').toLowerCase();
    if (following && DISPLAYS.indexOf(wantedDisplay) >= 0) {
      setDisplay(wantedDisplay);
    }

    announceMigration();

    if (global.Sync) {
      global.Sync.init({
        gotoAssembly: gotoAssembly,
        select: select,
        // The leader let its selection go. Unpinned as well as cleared, or
        // refresh() puts the card straight back up -- and a card left up
        // states an expectation for a part nothing on screen points at.
        clearCard: function () {
          pinned = false;
          BE.set({ selected: null });
          hideCard();
        },
        refresh: refresh,
        draw: function () { viewer.draw(); }
      });
    }
  };

  /**
   * Say what happened if an older store was brought forward on this load.
   *
   * Notes had no instrument in their key before this version, so they were
   * attributed to whichever unit is now active. That is a guess, and one worth
   * saying out loud once: on a bench with two calibrators it will be wrong for
   * half of them, and only the owner can tell which half.
   */
  function announceMigration() {
    var sessions = Log.adoptedCount();
    var notes = Notes.adoptedCount();
    if (!sessions && !notes) return;
    var parts = [];
    if (sessions) parts.push(sessions + ' session(s)');
    if (notes) parts.push(notes + ' annotated part(s)');
    setTimeout(function () {
      toast('Carried ' + parts.join(' and ') + ' forward to ' +
        Units.label(Units.active()) + (Units.wasAdopted() ? '' : ' — check the Log tab'));
    }, 400);
    Log.clearAdoptedFlag();
    Notes.clearAdoptedFlag();
    Units.clearAdoptedFlag();
  }

  /**
   * The unit picker stays out of the way until there is a choice to make. One
   * calibrator on the bench should not mean managing a registry; two makes it
   * the most important control on the page.
   */
  function renderUnitPicker() {
    var units = Units.all();
    var active = Units.active();
    el.unitSelect.innerHTML = units.map(function (u) {
      return '<option value="' + esc(u.id) + '"' +
        (active && u.id === active.id ? ' selected' : '') + '>' +
        esc(Units.label(u)) + '</option>';
    }).join('') + '<option value="__new">+ Add another unit…</option>';
    el.unitPicker.classList.toggle('needs-serial', Units.needsSerial());
    // Units.update existed and nothing called it, so a mistyped serial could
    // never be corrected and the placeholder unit made on first load could
    // never be named -- the whole first-run path had no way out.
    var edit = document.getElementById('unit-edit');
    if (edit) edit.title = active ? 'Rename ' + Units.label(active) : 'Name this unit';
  }

  /*
   * The serial question, asked in the page instead of by window.prompt.
   *
   * prompt() blocks the whole page, takes whatever the system dresses it in,
   * and in a browser set to suppress dialogs it never appears at all -- the
   * click lands, nothing happens, and the unit stays nameless with no clue
   * why. One positioned div under the picker asks the same one-field question
   * with the same commit rules, and stays part of the page. Not a <dialog>:
   * this file has to open from disk in old browsers.
   */
  var serialPop = null;      // the div, built on first use and kept
  var serialPopDone = null;  // receives the trimmed text on commit, null when shut

  function closeSerialPop() {
    if (!serialPop || serialPop.hidden) return;
    serialPop.hidden = true;
    serialPopDone = null;
    document.removeEventListener('mousedown', serialPopOutside, true);
  }

  // A press anywhere the popover is not is the ordinary way to walk away from
  // a question; it must cancel, not linger under whatever got clicked.
  function serialPopOutside(e) {
    if (!serialPop.contains(e.target)) closeSerialPop();
  }

  function commitSerialPop() {
    var fn = serialPopDone;
    var value = serialPop.querySelector('#serial-pop-input').value.trim();
    closeSerialPop();
    if (fn) fn(value);
  }

  function openSerialPop(label, initial, done) {
    if (!serialPop) {
      serialPop = document.createElement('div');
      serialPop.className = 'serial-pop';
      // Positioned and painted inline: this file may not touch the
      // stylesheet, and the colours are the panel's own tokens.
      serialPop.style.cssText = 'position:fixed;z-index:60;width:250px;' +
        'background:var(--pcb-panel);border:1px solid var(--rule);' +
        'border-radius:3px;box-shadow:0 12px 34px rgba(0,0,0,0.55);' +
        'padding:4px 0 8px';
      serialPop.innerHTML =
        '<div class="field"><span class="micro" id="serial-pop-label"></span>' +
        '<input id="serial-pop-input" type="text" autocomplete="off" ' +
        'spellcheck="false" placeholder="e.g. 5545001"></div>' +
        '<div class="btn-row">' +
        '<button class="btn primary" id="serial-pop-save" type="button">Save</button>' +
        '<button class="btn" id="serial-pop-cancel" type="button">Cancel</button></div>';
      document.body.appendChild(serialPop);
      serialPop.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          commitSerialPop();
        } else if (e.key === 'Escape') {
          // Stopped here, or the document handler would read the same press
          // as "clear the selection" -- a cancelled rename must not also
          // take down whatever was picked on the board.
          e.preventDefault();
          e.stopPropagation();
          closeSerialPop();
        }
      });
      serialPop.querySelector('#serial-pop-save')
        .addEventListener('click', commitSerialPop);
      serialPop.querySelector('#serial-pop-cancel')
        .addEventListener('click', closeSerialPop);
    }
    serialPop.querySelector('#serial-pop-label').textContent = label;
    var input = serialPop.querySelector('#serial-pop-input');
    input.value = initial || '';
    serialPopDone = done;
    serialPop.hidden = false;
    // Under the picker, on its left edge, and never off the window's right.
    var box = el.unitPicker.getBoundingClientRect();
    serialPop.style.top = (box.bottom + 6) + 'px';
    serialPop.style.left = Math.max(8, Math.min(box.left,
      global.innerWidth - serialPop.offsetWidth - 8)) + 'px';
    document.addEventListener('mousedown', serialPopOutside, true);
    input.focus();
    input.select();
  }

  function editUnit() {
    var u = Units.ensure();
    openSerialPop('Serial number for this calibrator', u.serial || '',
      function (serial) {
        // Committing an emptied field clears the serial, as the prompt did;
        // Escape, Cancel and a click elsewhere leave it alone.
        Units.update(u.id, { serial: serial });
        renderUnitPicker();
        refresh();
        toast(serial ? 'Unit is now ' + Units.label(Units.ensure())
                     : 'Serial cleared');
      });
  }

  /**
   * The open session for the board on screen, or null.
   *
   * A session carries the board it was opened on, and the log panel refuses to
   * show one opened on a different board -- so an A14 session left open while
   * A16 is on screen reads as "No open session" to the person looking at it.
   * It did not read that way to the recorders: they asked only whether *some*
   * session was open, so readings taken on A16 went into the A14 visit, where
   * the part card could not find them, the export named the wrong board, and
   * the panel that had just said there was nowhere to put them went on saying
   * it. Asking for the session of *this* board is the question all of them
   * meant to ask.
   */
  function sessionHere() {
    var s = Log.active();
    var id = BE.state.assembly && BE.state.assembly.id;
    return s && s.assembly === id ? s : null;
  }

  /**
   * Switch board and land on a part, for a link that crosses assemblies.
   *
   * The dropdown does not follow BE.state on its own -- until now the only
   * thing that ever changed the board was the dropdown itself, so it was always
   * already right. Recap mode's all-boards list is the first thing to move the
   * board from somewhere else, and a picker still reading A16 while A17 is on
   * screen is worse than no picker.
   */
  function gotoAssembly(id, ref) {
    if (!BE.get(id)) return;
    selectAssembly(id);
    el.assemblySelect.value = id;
    if (ref) select(ref, { focus: true });
    renderPanel();
  }

  function selectAssembly(id) {
    var dataset = BE.get(id);
    BE.set({ assembly: dataset, selected: null, hovered: null, highlighted: [] });
    rememberAssembly(id);
    // Sheet ids are per-assembly -- A11 runs to sh6 where A19 has only sh1 --
    // so the open sheet can name nothing on the new board. setSpace with an id
    // no schematic answers to builds an empty stage: black, no markers, and on
    // a one-sheet board no tabs to recover with.
    var sheets = dataset.schematics || [];
    if (!sheets.some(function (s) { return s.id === BE.state.sheet; })) {
      BE.set({ sheet: (sheets[0] || {}).id || 'sh1' });
    }
    // Which recap row is expanded belongs to the board you were on. Carrying it
    // across meant coming back to a part you had already worked on and finding
    // its row silently still open -- so the natural gesture, clicking the part
    // to see what you recorded, collapsed it instead. Nothing was lost; it read
    // exactly as though it had been. Coming back to a board starts folded.
    recapOpen = null;
    // A board change while the recap list is on screen re-asks which family
    // tab has anything under it -- the answer belongs to the board.
    if (BE.state.mode === 'recap') autoPickRecapFamily();
    // The procedure boxes, their chosen modes, their "recorded" pills and the
    // open repair form belong to that board too. Step numbers restart at 1 on
    // every board and test point refs repeat, so a value carried across
    // pre-fills another board's row, is scored against that board's limits,
    // and is one click from being recorded against it.
    procEntries = {};
    procState = {};
    procRecorded = {};
    activeStep = null;
    pendingRepair = null;
    // The history filters describe this board's records and legend. On the
    // next board their chips may not render at all -- a filter with no
    // matching history draws no chip and no Clear -- which leaves an empty
    // parts list and nothing on screen saying why.
    serviceFilter = null;
    activeKind = null;
    // Clearing the selection was not enough to take the card down, because a
    // pinned card stays up on its own. So the previous board's part hung over
    // the new board -- and a card reading "C39 · CAP,TA,22UF · NOT PLACED"
    // over A16, which has no C39, reads as a real part of the board in front
    // of you whose position is merely unknown. Published limits belonging to
    // another board are worth even less next to a live one.
    pinned = false;
    hideCard();
    if (!Log.active() || Log.active().assembly !== id) {
      var existing = Log.sessions().find(function (s) { return s.assembly === id; });
      if (existing) Log.setActive(existing.id);
    }
    applyDisplay();
    refresh();
    viewer.fit();
  }

  /* ================= events ================= */

  function wireEvents() {
    el.assemblySelect.addEventListener('change', function () {
      selectAssembly(el.assemblySelect.value);
    });

    // The pin grid is rebuilt on every render, so its listeners live on the
    // dock instead of on the inputs. Three behaviours make a sweep quick
    // enough to do with a probe in one hand: Enter walks the pins, a pasted
    // list fills them all at once, and changing the pin count rebuilds the
    // grid without losing what has already been typed.
    if (el.detailDockBody) {
      el.detailDockBody.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter' || !e.target.classList.contains('pin-v')) return;
        e.preventDefault();
        var inputs = Array.prototype.slice.call(
          el.detailDockBody.querySelectorAll('.pin-v'));
        var i = inputs.indexOf(e.target) + (e.shiftKey ? -1 : 1);
        if (i >= 0 && i < inputs.length) { inputs[i].focus(); inputs[i].select(); }
        else recordPinSweep();
      });

      el.detailDockBody.addEventListener('paste', function (e) {
        if (!e.target.classList.contains('pin-v')) return;
        var text = (e.clipboardData || global.clipboardData).getData('text');
        if (!text || !/[\s,;:=]/.test(text)) return;   // a single number: let it through
        e.preventDefault();
        applyPinValues(parsePinPaste(text, +e.target.dataset.pin));
      });

      el.detailDockBody.addEventListener('change', function (e) {
        if (e.target.id !== 'pin-count') return;
        var kept = [];
        forEachPinInput(function (inp) {
          if (inp.value.trim() !== '') kept.push({ pin: +inp.dataset.pin, v: inp.value.trim() });
        });
        pendingPinCount = Math.max(2, Math.min(64, +e.target.value || 8));
        e.target.value = pendingPinCount;
        pendingPinValues = kept;
        // Resize the grid, and only the grid, and only once the mouse is up.
        //
        // This change fires when the count field loses focus, and what it
        // loses focus to is usually the press on Save. Rebuilding the whole
        // dock there destroyed that button between mousedown and mouseup;
        // rebuilding just the grid still pushed it down out from under the
        // pointer. Either way no click was delivered and the sweep was
        // dropped with nothing said -- the same silent loss as the old bug of
        // opening the session before reading the form, by a different route.
        var regrid = function () {
          // The press this was waiting on may have been the save itself, and
          // a saved sweep has already re-rendered the dock off its own count.
          if (pendingPinCount == null) return;
          var grid = el.detailDockBody.querySelector('#pin-grid');
          var item = BE.state.selected ? BE.lookup(BE.state.selected) : null;
          if (!grid || !item) { renderDetailDock(); return; }
          var last = Log.lastPins(BE.state.assembly.id, item.ref);
          grid.innerHTML = pinCellsHTML(pendingPinCount, last ? pinMap(last) : null);
          applyPinValues(kept);
          var why = el.detailDockBody.querySelector('.pin-why');
          if (why) why.textContent = 'set by you for this sweep';
        };
        if (mouseIsDown) pinRegrid = regrid; else regrid();
      });
    }

    // The press that moved focus off the pin count has to finish before the
    // grid is allowed to change size. Capture, so this runs ahead of the
    // dock's own handlers, and before the click that a saved sweep depends on.
    global.document.addEventListener('mousedown', function () {
      mouseIsDown = true;
    }, true);
    global.document.addEventListener('mouseup', function () {
      mouseIsDown = false;
      if (!pinRegrid) return;
      var fn = pinRegrid;
      pinRegrid = null;
      // After the click, not merely after the release: the click is what
      // saves, and it is entitled to find the form exactly as it was left.
      global.setTimeout(fn, 0);
    }, true);

    el.unitSelect.addEventListener('change', function () {
      if (el.unitSelect.value === '__new') {
        // The select snaps back to the active unit before the question is
        // asked -- it must not stand reading "+ Add another unit…" while the
        // answer is still open, or after a cancel.
        renderUnitPicker();
        openSerialPop('Serial number of the new calibrator', '',
          function (serial) {
            // Nothing typed: a unit with no serial is what we already have
            // one of, and a second nameless one helps nobody.
            if (!serial) return;
            Units.create({ serial: serial });
            toast('Now recording against ' + Units.label(Units.active()));
            renderUnitPicker();
            selectAssembly(BE.state.assembly.id);
          });
        return;
      }
      Units.setActive(el.unitSelect.value);
      toast('Now recording against ' + Units.label(Units.active()));
      renderUnitPicker();
      // Sessions, notes and repairs all belong to the unit, so the selection
      // and every panel are about a different instrument now.
      selectAssembly(BE.state.assembly.id);
    });

    el.searchInput.addEventListener('input', function () {
      var q = el.searchInput.value.trim();
      var hits = Search.run(q, { testPointsOnly: BE.state.mode === 'testpoints' });
      BE.set({ highlighted: q ? hits.map(function (h) { return h.item.ref; }) : [] });
      renderPanel();
      viewer.draw();
      // A single unambiguous hit is what someone typing a designator wants:
      // go there without making them click the one result.
      if (q && hits.length === 1) select(hits[0].item.ref, { focus: true });
    });

    el.searchInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        var hits = Search.run(el.searchInput.value.trim(),
          { testPointsOnly: BE.state.mode === 'testpoints' });
        if (hits.length) select(hits[0].item.ref, { focus: true });
      } else if (e.key === 'Escape') {
        el.searchInput.value = '';
        BE.set({ highlighted: [] });
        el.searchInput.blur();
        refresh();
      }
    });

    el.modeTabs.addEventListener('click', function (e) {
      var btn = e.target.closest('button');
      if (!btn) return;
      if (btn.dataset.mode === 'author') { toggleAuthorFromTab(); return; }
      setMode(btn.dataset.mode);
    });

    el.displayTabs.addEventListener('click', function (e) {
      var btn = e.target.closest('button');
      if (btn) setDisplay(btn.dataset.display);
    });

    el.sheetTabs.addEventListener('click', function (e) {
      var btn = e.target.closest('button');
      if (!btn) return;
      BE.set({ sheet: btn.dataset.sheet });
      applyDisplay();
      refresh();
    });

    // The whole header is the hit target, not just the chevron -- it is a
    // strip of dead space otherwise, and this is a thing you collapse often.
    el.unitEdit.addEventListener('click', editUnit);

    el.detailDockHead.addEventListener('click', function (e) {
      if (e.target.closest('#detail-dock-close')) return;
      cycleDockFold();
    });

    // Dragging the top edge sizes the dock.
    //
    // The move and release are tracked on the window rather than on the strip.
    // The strip is five pixels tall, so the pointer is off it before the first
    // move arrives; pointer capture would also cover that, but capture can
    // refuse (a synthetic or already-released pointer throws NotFoundError) and
    // a resize that silently does nothing is worse than one that ignores an
    // optimisation. Capture is attempted for the cursor it keeps, not relied on.
    (function () {
      var from = 0, startH = 0, dragging = false, pid = null;

      function onMove(e) {
        if (!dragging) return;
        e.preventDefault();
        // Dragging up grows the dock, which is why the delta is inverted.
        setDockHeight(startH + (from - e.clientY), false);
      }

      function onUp() {
        if (!dragging) return;
        dragging = false;
        global.removeEventListener('pointermove', onMove);
        global.removeEventListener('pointerup', onUp);
        global.removeEventListener('pointercancel', onUp);
        if (pid != null) {
          try { el.detailDockResize.releasePointerCapture(pid); } catch (err) { /* never held */ }
          pid = null;
        }
        el.detailDockResize.classList.remove('is-dragging');
        document.body.classList.remove('is-resizing-dock');
        setDockHeight(dockHeight, true);
      }

      el.detailDockResize.addEventListener('pointerdown', function (e) {
        // Nothing to size at either of the folded stops: one has no body and
        // the other is exactly as tall as the box it holds.
        if (effectiveFold() !== 'full') return;
        e.preventDefault();
        from = e.clientY;
        startH = el.detailDock.getBoundingClientRect().height;
        dragging = true;
        pid = e.pointerId;
        try { el.detailDockResize.setPointerCapture(e.pointerId); } catch (err) { pid = null; }
        el.detailDockResize.classList.add('is-dragging');
        document.body.classList.add('is-resizing-dock');
        global.addEventListener('pointermove', onMove);
        global.addEventListener('pointerup', onUp);
        global.addEventListener('pointercancel', onUp);
      });

      // A double-click on the strip gives the automatic height back.
      el.detailDockResize.addEventListener('dblclick', function () {
        dockHeight = 0;
        try {
          global.localStorage.removeItem(DOCK_H_KEY);
        } catch (err) { /* nothing to forget */ }
        applyDockHeight();
      });
    }());

    // A window that got shorter can leave a remembered height taller than the
    // column, which would squeeze the list out; the clamp is re-applied.
    global.addEventListener('resize', function () { applyDockHeight(); });

    el.detailDockClose.addEventListener('click', function () {
      pinned = false;
      BE.set({ selected: null });
      hideCard();
      refresh();
    });

    el.opacitySlider.addEventListener('input', function () {
      BE.state.overlayOpacity = el.opacitySlider.value / 100;
      applyLayerVisibility();
    });

    el.fitBtn.addEventListener('click', fitAll);

    var linkedBtn = document.getElementById('linked-view-btn');
    if (linkedBtn) {
      linkedBtn.addEventListener('click', function () {
        // A follower opens on the schematic by default: the common bench
        // shape is board here, schematic on the other monitor.
        var opened = global.Sync.openFollower('schematic');
        // A blocked popup opens nothing and says nothing; confirming a linked
        // view that is not there sends someone looking at the other monitor
        // for a window the browser refused to make.
        toast(opened ? 'Linked view opened — it follows this window' :
          'The browser blocked the linked view — allow pop-ups for this page, then try again');
      });
    }

    wireSwipeDivider();

    document.addEventListener('keydown', onKeyDown);
    BE.on('testlog', function () { if (!suppressLogRefresh) refresh(); });
    // A failed write is the one thing that must not scroll away. The toast
    // clears itself after 2.6 s, which is right for "recorded" and wrong for
    // "not recorded", so this one stays until the export that rescues the
    // readings still held in memory.
    BE.on('storage', function () {
      el.toast.textContent = 'Storage is full — this reading is in memory only. ' +
        'Export the log now, then clear space.';
      el.toast.hidden = false;
      el.toast.classList.add('is-alarm');
      clearTimeout(toastTimer);
    });
    BE.on('notes', function () { refresh(); });
    BE.on('procedure', function () { renderPanel(); });
    // Every path that changes a unit emits this, so subscribing the picker
    // makes a stale picker impossible by construction. The call sites that
    // already refresh it by hand stay: rendering twice costs nothing, and a
    // call site that forgets is exactly what this line is for.
    BE.on('unit', function () { renderUnitPicker(); });
  }

  /**
   * Dragging the seam between the photograph and the drawing.
   *
   * The seam is its own control rather than a gesture on the board, because
   * the board itself has to stay draggable: you need to pan to the corner you
   * are comparing before you can usefully wipe across it.
   */
  function wireSwipeDivider() {
    var el2 = el.swipeDivider;
    if (!el2) return;

    function setFrom(clientX) {
      var box = el.stage.getBoundingClientRect();
      var f = (clientX - box.left) / box.width;
      setSwipe(Math.min(1, Math.max(0, f)));
    }

    el2.addEventListener('pointerdown', function (e) {
      el2.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    el2.addEventListener('pointermove', function (e) {
      if (e.buttons !== 1) return;
      setFrom(e.clientX);
    });
    el2.addEventListener('keydown', function (e) {
      var step = e.shiftKey ? 0.1 : 0.02;
      if (e.key === 'ArrowLeft') setSwipe(Math.max(0, swipeFraction - step));
      else if (e.key === 'ArrowRight') setSwipe(Math.min(1, swipeFraction + step));
      else return;
      e.preventDefault();
    });
  }

  function setSwipe(fraction) {
    swipeFraction = fraction;
    el.swipeDivider.style.left = (fraction * 100).toFixed(2) + '%';
    el.swipeDivider.setAttribute('aria-valuenow', Math.round(fraction * 100));
    applyLayerVisibility();
  }

  /**
   * Clip the drawing at the divider, in screen space.
   *
   * The inset percentage resolves against the image's own box and rides its
   * transform, so a fraction of the stage is the wrong unit the moment the
   * view pans or zooms — the seam drifted away from the divider. Convert the
   * divider's screen position into the drawing's own fraction through the
   * live transform instead; the viewer calls back here on every change.
   */
  function syncSwipeClip() {
    if (BE.state.display !== 'swipe') return;
    var rec = viewer.layers && viewer.layers.drawing;
    if (!rec || !viewer.scale) return;
    var sb = el.stage.getBoundingClientRect();
    var vb = viewer.root.getBoundingClientRect();
    var seamX = sb.left + swipeFraction * sb.width - vb.left;
    var u = Math.min(1, Math.max(0, (seamX - viewer.tx) / viewer.scale));
    rec.img.style.clipPath = 'inset(0 0 0 ' + (u * 100).toFixed(3) + '%)';
  }

  /** A split has two panes, and both answer to the one fit control. */
  function fitAll() {
    viewer.fit();
    if (BE.state.display === 'split') secondary.fit();
  }

  /** The display a number key names, or null where it names none. */
  function displayForKey(key) {
    var n = /^[0-9]$/.test(key) ? +key : 0;
    return n >= 1 && n <= DISPLAYS.length ? DISPLAYS[n - 1] : null;
  }

  function onKeyDown(e) {
    var wantsDisplay = displayForKey(e.key);
    if (document.body.classList.contains('follower')) {
      // Chords are the browser's: Cmd/Ctrl+1..6 changes tab and Cmd/Ctrl+Z is
      // undo, and neither is a request to re-fit or re-display this window.
      // Read raw they would do both at once, since nothing here is prevented.
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      // A follower owns its view and nothing else: displays, fit, and
      // putting the card away. Everything that navigates or records
      // belongs to the leader.
      if (wantsDisplay) { setDisplay(wantsDisplay); }
      else if (e.key.toLowerCase() === 'z') { fitAll(); }
      else if (e.key === 'Escape') { pinned = false; hideCard(); }
      return;
    }
    var typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
    if (e.key === '/' && !typing) {
      e.preventDefault();
      el.searchInput.focus();
      el.searchInput.select();
      return;
    }
    if (typing) {
      // Escape in a field steps out of the field, and that is all it does:
      // the selection stands, an open form stands, and the text just typed
      // stands with it. What it buys is the keyboard back -- after a save the
      // input kept focus, and every shortcut on the status line was being
      // typed into the box instead of doing its job. Fields with their own
      // Escape (the search box, the serial popover) have already acted by
      // the time this runs.
      if (e.key === 'Escape') {
        e.preventDefault();
        document.activeElement.blur();
      }
      return;
    }
    // Escape used to be handled above this guard, so it fired while a field
    // had focus: typing a symptom into a repair form and pressing Escape --
    // the ordinary way to dismiss a form -- cleared the selection, tore down
    // the form and took the text with it, with no undo. Below the guard it
    // only ever means "nothing selected", which is what it says.
    if (e.key === 'Escape') {
      pinned = false;
      BE.set({ selected: null, highlighted: [] });
      hideCard();
      refresh();
      return;
    }
    // Cmd/Ctrl chords belong to the editor (undo) and to the browser, not to
    // the single-letter shortcuts below.
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    var map = { b: 'board', t: 'testpoints', l: 'log', p: 'procedure', f: 'faults',
                r: 'recap' };
    if (e.key.toLowerCase() === 'a') { toggleAuthorFromTab(); return; }
    if (map[e.key.toLowerCase()]) { setMode(map[e.key.toLowerCase()]); return; }

    // The measurement box without reaching for the mouse. Selecting a point
    // deliberately does not focus it: every shortcut here is a single letter,
    // and a box that took the caret on selection would eat all of them.
    // Escape gives them back, in the typing guard above.
    if (e.key.toLowerCase() === 'm') {
      var box = document.getElementById('measure-input');
      if (box) { box.focus(); box.select(); return; }
    }

    if (wantsDisplay) { setDisplay(wantsDisplay); return; }

    if (e.key.toLowerCase() === 'd' && !el.detailDock.hidden) {
      cycleDockFold();
      return;
    }
    if (e.key.toLowerCase() === 'z') { fitAll(); return; }
    if (e.key.toLowerCase() === 's' && BE.state.selected) { showOnSchematic(BE.state.selected); }
  }

  function setMode(mode) {
    if (!mode || BE.state.mode === mode) return;
    BE.set({ mode: mode });
    // The floating card describes something picked in the mode being left,
    // and left up it floats over panels that have nothing to do with it -- a
    // test point's limits hanging over the recap list for the rest of the
    // session. The selection itself survives the switch, and the dock with
    // it; only the card comes down. Unpinned too, or refresh() would put it
    // straight back up.
    pinned = false;
    hideCard();
    if (mode === 'recap') autoPickRecapFamily();
    Array.prototype.forEach.call(el.modeTabs.children, function (b) {
      b.classList.toggle('is-active', b.dataset.mode === mode);
    });
    refresh();
  }

  /**
   * Turn Author Mode on or off in place.
   *
   * The two modes show the same board -- saved edits are applied either way --
   * so nothing has to be loaded or thrown away here. What changes is whether the
   * board can be edited: the drag handles, the Author panel, the coverage badge
   * and the editor's own keys. Author.arm() attaches that the first time it is
   * needed and is a no-op after, so switching back and forth is free.
   *
   * The URL is kept in step with replaceState rather than by navigating: a
   * reload then lands you back where you were, and the address bar stays
   * something you can send to someone else, without a page load between clicks.
   */
  function setAuthorMode(on) {
    if (BE.state.author === on) return;
    BE.state.author = on;
    document.body.classList.toggle('author', on);
    if (on && global.Author && global.Author.arm) global.Author.arm();

    var params = new URLSearchParams(location.search);
    if (on) params.set('author', '1'); else params.delete('author');
    var q = params.toString();
    history.replaceState(null, '', location.pathname + (q ? '?' + q : '') + location.hash);
    syncAuthorTab();

    // Leaving the mode with its own panel still open would show an editor that
    // no longer responds, so step back to the board.
    if (!on && BE.state.mode === 'author') setMode('board');
    else refresh();
    viewer.draw();
  }

  var LAST_ASM_KEY = 'fluke5700a.lastassembly.v1';

  /**
   * Keep the board you are on across a reload.
   *
   * Two mechanisms, because they answer different questions. The URL is updated
   * in place so a refresh -- or a link you send someone -- lands on the board
   * you were actually looking at, the same way Author Mode keeps its flag there.
   * Storage covers the other case: opening the tool fresh from a bookmark or a
   * shortcut that carries no query at all, which is how it gets opened at a
   * bench.
   */
  function rememberAssembly(id) {
    try { global.localStorage.setItem(LAST_ASM_KEY, id); } catch (err) { /* fine */ }
    var params = new URLSearchParams(location.search);
    params.set('assembly', id);
    history.replaceState(null, '', location.pathname + '?' + params.toString() + location.hash);
  }

  function rememberedAssembly() {
    try { return global.localStorage.getItem(LAST_ASM_KEY) || ''; } catch (err) { return ''; }
  }

  function syncAuthorTab() {
    if (!el.authorTab) return;
    el.authorTab.classList.toggle('is-off', !BE.state.author);
    el.authorTab.title = BE.state.author
      ? 'Author Mode is on — click to turn it off'
      : 'Author Mode is off — click to edit positions and test point data';
  }

  function toggleAuthorFromTab() {
    // Off: switch it on and go straight to the panel, since that is what
    // someone reaching for it wants. On and already showing: switch it off.
    if (!BE.state.author) { setAuthorMode(true); setMode('author'); }
    else if (BE.state.mode === 'author') setAuthorMode(false);
    else setMode('author');
  }

  function setDisplay(display) {
    if (!display || BE.state.display === display) return;
    // The Photo/Overlay/Swipe buttons are disabled until the photo has an
    // alignment, but the 1-6 shortcuts arrive without passing them, and an
    // unaligned photo cannot be shown: the drawing would be hidden and the
    // photo withheld, leaving markers floating on a black stage with nothing
    // saying why. Same gate, same words as the buttons' tooltip.
    if (/^(photo|overlay|swipe)$/.test(display)) {
      var aligned = ((BE.state.assembly || {}).layers || []).some(function (l) {
        return l.id === 'photo' && l.transform;
      });
      if (!aligned) {
        toast('The photo has no alignment yet — set landmarks in Author Mode');
        return;
      }
    }
    BE.set({ display: display });
    applyDisplay();
    refresh();
  }

  /* ================= display modes ================= */

  /**
   * What a sheet tab says, as opposed to what the sheet is called.
   *
   * Sheet titles run to 93 characters -- A4's second sheet is "Transformer
   * Assembly Interconnect, Secondary Voltages and P81/P82 to the Analog
   * Motherboard" -- and three of those in a row measured 1395px inside a
   * 1082px controls row, which put A4's third sheet 500px past the edge of
   * the stage where it could not be clicked at all. Six-sheet boards like A11
   * are worse.
   *
   * The first clause is the part that tells one sheet from another; the rest
   * elaborates, and belongs in the tooltip. Four words is the target, applied
   * in the order that keeps the most meaning: drop any parenthetical, take the
   * first clause, and only if that is still long break it at "and" -- because
   * "EEPROM and EPROM" is three words and breaking it would throw away half a
   * title that was already short enough. A hard truncation is the last resort
   * and gets an ellipsis so it does not read as the whole name.
   */
  var SHEET_WORDS = 4;

  function shortSheetTitle(full) {
    var t = String(full).replace(/\s*\([^)]*\)/g, '').trim();
    t = t.split(/[:,]/)[0].trim() || t;
    if (t.split(/\s+/).length > SHEET_WORDS) t = t.split(/\s+and\s+/i)[0].trim();
    var words = t.split(/\s+/);
    if (words.length > SHEET_WORDS) t = words.slice(0, SHEET_WORDS).join(' ') + '…';
    return t || String(full);
  }

  function applyDisplay() {
    var dataset = BE.state.assembly;
    var display = BE.state.display;

    Array.prototype.forEach.call(el.displayTabs.children, function (b) {
      b.classList.toggle('is-active', b.dataset.display === display);
    });

    var hasPhoto = (dataset.layers || []).some(function (l) {
      return l.id === 'photo' && l.transform;
    });
    Array.prototype.forEach.call(el.displayTabs.children, function (b) {
      var needsPhoto = /^(photo|overlay|swipe)$/.test(b.dataset.display);
      b.disabled = needsPhoto && !hasPhoto;
      b.title = b.disabled
        ? 'The photo has no alignment yet — set landmarks in Author Mode'
        : '';
    });

    var sheets = dataset.schematics || [];
    el.sheetTabs.hidden = !/^(schematic|split)$/.test(display) || sheets.length < 2;
    if (!el.sheetTabs.hidden) {
      el.sheetTabs.innerHTML = sheets.map(function (s, i) {
        var full = s.title || s.id;
        return '<button data-sheet="' + s.id + '"' +
          (BE.state.sheet === s.id ? ' class="is-active"' : '') +
          ' title="' + esc(full) + '">' +
          '<span class="sheet-n">' + (i + 1) + '</span>' +
          '<span class="sheet-name">' + esc(shortSheetTitle(full)) + '</span>' +
          '</button>';
      }).join('');
    }

    el.opacityGroup.hidden = display !== 'overlay';
    el.stage.classList.toggle('is-split', display === 'split');
    el.stage.classList.toggle('is-swipe', display === 'swipe');

    if (display === 'schematic') {
      viewer.setSpace(BE.state.sheet, dataset);
    } else {
      viewer.setSpace('board', dataset);
    }
    if (display === 'split') {
      secondary.setSpace(BE.state.sheet, dataset);
      setTimeout(function () { secondary.resize(); secondary.fit(); }, 0);
    }
    setTimeout(function () { viewer.resize(); }, 0);
    applyLayerVisibility();
    renderZoneFrame();
  }

  function applyLayerVisibility() {
    var display = BE.state.display;
    var stage = viewer.stage;
    // The line-art drawing is inverted for every mode except plain "Drawing",
    // where the original black-on-white sheet is what a service tech expects.
    stage.dataset.invert = display === 'drawing' ? '0' : '1';

    var hasHomography = !!((BE.state.assembly.layers || []).find(function (l) {
      return l.id === 'photo' && l.transform && l.transform.H;
    }));

    Object.keys(viewer.layers).forEach(function (id) {
      var img = viewer.layers[id].img;
      img.style.clipPath = '';
      if (id === 'drawing') {
        img.style.display = display === 'photo' ? 'none' : '';
        img.style.opacity = display === 'overlay' ? BE.state.overlayOpacity : 1;
        if (display === 'swipe') syncSwipeClip();
      } else if (id === 'photo') {
        // Without an alignment the photo cannot be placed in board space, so
        // showing it would put every marker in the wrong place.
        var wanted = /^(photo|overlay|swipe)$/.test(display);
        img.style.display = (wanted && hasHomography) ? '' : 'none';
        img.style.opacity = 1;
      }
    });
    viewer.applyLayerTransforms();
  }

  /** The zone ruler around the stage: real printed zones on a schematic. */
  function renderZoneFrame() {
    var dataset = BE.state.assembly;
    var display = BE.state.display;
    var sheet = (dataset.schematics || []).find(function (s) { return s.id === BE.state.sheet; });
    var cols, rows;
    if (display === 'schematic' && sheet && sheet.grid) {
      cols = sheet.grid.cols;
      rows = sheet.grid.rows;
    } else {
      cols = ['8', '7', '6', '5', '4', '3', '2', '1'];
      rows = ['D', 'C', 'B', 'A'];
    }
    el.zoneframe.hidden = display === 'split';
    fillEdge(el.zoneframe.querySelector('.top'), cols);
    fillEdge(el.zoneframe.querySelector('.bottom'), cols);
    fillEdge(el.zoneframe.querySelector('.left'), rows);
    fillEdge(el.zoneframe.querySelector('.right'), rows);
  }

  function fillEdge(node, labels) {
    node.innerHTML = labels.map(function (l) {
      return '<span class="zoneframe-cell">' + esc(l) + '</span>';
    }).join('');
  }

  /* ================= items on the viewers ================= */

  function refresh() {
    var dataset = BE.state.assembly;
    if (!dataset) return;
    var verdicts = Log.verdicts(dataset.id);
    viewer.setVerdicts(verdicts);
    secondary.setVerdicts(verdicts);
    viewer.setItems(itemsFor(viewer.space, dataset));
    if (BE.state.display === 'split') {
      secondary.setItems(itemsFor(secondary.space, dataset));
    }
    renderPanel();
    renderStatus();
    renderCoverage();
    if (pinned && BE.state.selected) showCardFor(BE.lookup(BE.state.selected), null, true);
  }

  function itemsFor(space, dataset) {
    var mode = BE.state.mode;
    var pool = (mode === 'testpoints' || mode === 'log')
      ? (dataset.testpoints || [])
      : BE.items(dataset);
    var out = [];
    pool.forEach(function (item) {
      if (space === 'board') {
        if (!item.board) return;
        out.push({
          ref: item.ref, item: item,
          x: item.board.x, y: item.board.y,
          w: item.board.w, h: item.board.h,
          shape: item.board.shape || (item.isTestPoint ? 'point' : 'rect'),
          unverified: !item.verified,
          color: markerColor(item, dataset)
        });
      } else {
        (item.sch || []).forEach(function (s, i) {
          if (s.sheet !== space) return;
          out.push({
            ref: item.ref, item: item, occurrence: i,
            x: s.x, y: s.y, w: s.w, h: s.h,
            shape: s.shape || (item.isTestPoint ? 'point' : 'rect'),
            unverified: !item.schVerified,
            color: markerColor(item, dataset)
          });
        });
      }
    });
    return out;
  }

  /*
   * Markers are coloured by what the part is, so the board reads as a map of
   * component types before you have searched for anything: the bank of
   * electrolytics along the top, the diode bridges, the row of fuses. Test
   * points ignore this and take their supply rail's colour instead, because
   * when you are looking at test points the rail is what you are tracing.
   *
   * Hues are spaced widely enough to stay apart on the dark background, and
   * kept clear of the three colours that already carry meaning: cyan for the
   * current selection, amber for a marginal reading, red for a failed one.
   */
  var KIND_COLORS = {
    cap:        '#4a9fd8',
    res:        '#d6a15e',
    diode:      '#63bd6e',
    zener:      '#3fc4a4',
    transistor: '#a98cf0',
    ic:         '#e37ab5',
    resnet:     '#8b7fd6',
    fuse:       '#f0894f',
    relay:      '#d8c355',
    switch:     '#d8c355',
    thermistor: '#e08268',
    // A4 brings the varistor family (RV1, RV2). Kept in the warm end with the
    // fuse and the thermistor, which is the company it keeps on the board: the
    // three parts whose job is to survive something the instrument should not
    // have been given.
    varistor:   '#e0a13f',
    connector:  '#7f96b4',
    jumper:     '#9aa4b0',
    // These five have had labels in KIND_LABELS since A17 introduced them, but
    // no colour, so they fell through to `part` -- which is within a few points
    // of `cap`. On A10 that put L4 and L5 in the same blue as the capacitors
    // beside them while the legend swatch said "Inductors", which is worse than
    // an obviously generic colour: it reads as a colour that means something.
    // Sockets and wires stay in the grey family on purpose, with jumper and
    // mech: what they have in common is that nothing about them fails.
    inductor:    '#9dbf4a',
    transformer: '#bf7a3f',
    crystal:     '#5fc8d8',
    socket:      '#7d8794',
    // A20 brings two families no earlier board had. Both get a colour as well
    // as a label for the reason the note above records: a kind with a label and
    // no colour falls through to `part`, which is within a few points of `cap`,
    // and a legend swatch that means nothing is worse than an obviously generic
    // one. The reset lamp and the clock battery are the two parts on that board
    // a technician looks at first, so neither should be indistinguishable from
    // the rectifier diodes or filed under "Other".
    led:         '#e8d44d',
    battery:     '#c96f4a',
    wire:        '#b0b8c2',
    mech:       '#68717f',
    part:       '#5b9dd9'
  };

  var KIND_LABELS = {
    cap: 'Capacitors', res: 'Resistors', diode: 'Diodes', zener: 'Zeners',
    transistor: 'Transistors', ic: 'ICs', resnet: 'Resistor networks',
    fuse: 'Fuses', relay: 'Relays', switch: 'Switches',
    thermistor: 'Thermistors', varistor: 'Varistors',
    connector: 'Connectors', jumper: 'Jumpers',
    inductor: 'Inductors', transformer: 'Transformers', crystal: 'Crystals',
    socket: 'IC sockets', wire: 'Wires',
    led: 'LEDs', battery: 'Batteries',
    mech: 'Mechanical', part: 'Other'
  };

  function markerColor(item, dataset) {
    var d = dataset || BE.state.assembly;
    if (item.isTestPoint) {
      var rail = (d.rails || {})[item.rail];
      return rail && rail.color ? rail.color : KIND_COLORS.jumper;
    }
    return KIND_COLORS[item.kind] || KIND_COLORS.part;
  }
  App.markerColor = markerColor;

  /**
   * Test points are one chip, not five.
   *
   * They are listed alongside the parts and are the thing a reader reaches for
   * most, but they were missing from the legend entirely because it only ever
   * counted `components`. They also carry several kinds of their own --
   * wire-loop, pad, hv-socket, thru-hole, socket -- which describe how the
   * point is built rather than what it is for, and splitting the legend by
   * those would be five chips answering a question nobody asked. So they group
   * under one synthetic key.
   */
  // A plain string, because this travels through a data-kind attribute and back:
  // HTML parsing replaces U+0000 in an attribute value, so a NUL sentinel does
  // not survive the round trip. 'testpoint' is a real kind (assemble.py gives it
  // to a test point with no parts-list row), hence the doubled underscore.
  var TESTPOINT_KIND = '__testpoints';

  function matchesKind(item, kind) {
    return kind === TESTPOINT_KIND ? !!item.isTestPoint : item.kind === kind;
  }

  /** Which types are actually on this board, in descending count order. */
  function kindLegendHTML() {
    var d = BE.state.assembly;
    var counts = {};
    (d.components || []).forEach(function (c) {
      counts[c.kind] = (counts[c.kind] || 0) + 1;
    });
    var tps = (d.testpoints || []).length;
    if (tps) counts[TESTPOINT_KIND] = tps;
    var kinds = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; });
    return '<div class="kindlegend">' + kinds.map(function (k) {
      // A test point takes its marker colour from the rail it belongs to, so no
      // single swatch is true for all of them; the swatch shows the colour an
      // unrailed one already gets.
      var color = k === TESTPOINT_KIND
        ? KIND_COLORS.jumper : (KIND_COLORS[k] || KIND_COLORS.part);
      var label = k === TESTPOINT_KIND ? 'Test points' : (KIND_LABELS[k] || k);
      return '<button class="kindchip' + (activeKind === k ? ' is-active' : '') +
        '" data-kind="' + esc(k) + '">' +
        '<span class="swatch" style="background:' + color + '"></span>' +
        esc(label) + '<span class="kindcount">' + counts[k] + '</span></button>';
    }).join('') + '</div>';
  }

  /* ================= selection and the info card ================= */

  function select(ref, opts) {
    var options = opts || {};
    var item = BE.lookup(ref);
    if (!item) return;
    stateIndex = 0;
    BE.set({ selected: ref });
    if (options.focus) focusOn(item);
    else if (options.followSheet) followSheetOnClick(item);
    pinned = true;
    showCardFor(item, null, true);
    refresh();
  }

  /** Whichever pane is showing a schematic right now, if either one is. */
  function schematicPane() {
    if (BE.state.display === 'split') return secondary;
    if (BE.state.display === 'schematic') return viewer;
    return null;
  }

  /**
   * Which drawing of a part the schematic pane should show.
   *
   * A part drawn on the sheet already open wins over every other occurrence: a
   * part you can already see is never a reason to turn the page. Failing that,
   * the first occurrence — which is the one the info card names first, so the
   * sheet you land on is the sheet you were told about.
   */
  function schOccurrence(item, space) {
    var list = item.sch || [];
    var here = list.find(function (p) { return p.sheet === space; });
    return here || list[0] || null;
  }

  /**
   * Turn the schematic pane to the sheet this part is drawn on.
   *
   * Deliberately does not move the viewport: turning to the right page and
   * re-framing that page are two decisions, and not every caller wants both.
   * The return value says which occurrence is now on show and whether the
   * sheet actually had to change, so the caller can decide the second one.
   *
   * In a split, only the schematic half follows. The board half has no sheets
   * to follow, and it is the half you are comparing against.
   */
  function followSheet(item, opts) {
    var pane = schematicPane();
    if (!pane) return null;
    var target = schOccurrence(item, pane.space);
    if (!target) {
      if (opts && opts.announce) toast(item.ref + ' has no schematic location yet');
      return null;
    }
    var switched = target.sheet !== pane.space;
    if (switched) {
      BE.set({ sheet: target.sheet });
      applyDisplay();
      pane.setItems(itemsFor(pane.space, BE.state.assembly));
    }
    return { pane: pane, occurrence: target, switched: switched };
  }

  /**
   * An explicit click on a marker follows it to the sheet it is drawn on.
   *
   * Only on a click: doing this on hover would flip the schematic out from
   * under the pointer every time it crossed a marker. And the viewport moves
   * only when the sheet does — clicking a part you can already see should
   * select it, not yank the view to re-centre something never off screen.
   */
  function followSheetOnClick(item) {
    var moved = followSheet(item, { announce: true });
    if (!moved) return;
    var o = moved.occurrence;
    // The frame only moves when the sheet changed, but the pulse fires either
    // way: on a sheet you were already looking at, it is the only thing that
    // says which of the markers you just picked.
    if (moved.switched) moved.pane.focus({ x: o.x, y: o.y, w: o.w, h: o.h });
    moved.pane.flash(item.ref);
  }

  function focusOn(item) {
    if (viewer.space === 'board' && item.board) {
      viewer.focus({ x: item.board.x, y: item.board.y, w: item.board.w, h: item.board.h });
      viewer.flash(item.ref);
    }
    // A part reached by name — from the parts list, a chip, a search hit — is
    // being looked for rather than looked at, so the schematic half turns to
    // its sheet and frames it there even when that means leaving this one.
    var moved = followSheet(item);
    if (moved) {
      var o = moved.occurrence;
      moved.pane.focus({ x: o.x, y: o.y, w: o.w, h: o.h });
      moved.pane.flash(item.ref);
    }
  }

  /**
   * Board → schematic: jump to where this part is drawn.
   *
   * `occurrence` names one drawing of the part explicitly, for the info card
   * where each one is listed separately. Without it the pane picks for itself,
   * which is what the keyboard shortcut wants: stay on this sheet if the part
   * is on it, and only turn the page when it is not.
   */
  function showOnSchematic(ref, occurrence) {
    var item = BE.lookup(ref);
    if (!item) return;
    var pane = schematicPane();
    var target = occurrence == null
      ? schOccurrence(item, pane && pane.space)
      : (item.sch || [])[occurrence];
    if (!target) {
      toast(ref + ' has no schematic location yet');
      return;
    }
    // A display already showing this sheet needs no new layout, and re-applying
    // one would re-fit the split panes out from under the focus below. A sheet
    // change does need it, even when the display itself is staying put — that
    // is what points the pane at the new sheet.
    var relayout = BE.state.sheet !== target.sheet ||
      !/^(schematic|split)$/.test(BE.state.display);
    BE.set({ sheet: target.sheet, selected: ref });
    if (!/^(schematic|split)$/.test(BE.state.display)) BE.set({ display: 'schematic' });
    if (relayout) applyDisplay();
    refresh();
    var pane = schematicPane() || viewer;
    pane.focus({ x: target.x, y: target.y, w: target.w, h: target.h });
    pane.flash(ref);
  }

  /** Schematic → board: jump back to the part on the board. */
  function showOnBoard(ref) {
    var item = BE.lookup(ref);
    if (!item || !item.board) {
      toast(ref + ' has no board location yet');
      return;
    }
    if (/^(schematic)$/.test(BE.state.display)) setDisplay('drawing');
    BE.set({ selected: ref });
    refresh();
    viewer.focus({ x: item.board.x, y: item.board.y, w: item.board.w, h: item.board.h });
    viewer.flash(ref);
  }

  App.showOnSchematic = showOnSchematic;
  App.showOnBoard = showOnBoard;
  App.select = select;

  /** A secondary-pane position, moved into the primary pane's frame. */
  function secondaryPos(pos) {
    if (!pos) return pos;
    var a = el.viewportSecondary.getBoundingClientRect();
    var b = el.viewport.getBoundingClientRect();
    return [pos[0] + (a.left - b.left), pos[1] + (a.top - b.top)];
  }

  function onHover(hit, pos) {
    var ref = hit ? hit.ref : null;
    if (BE.state.hovered !== ref) BE.set({ hovered: ref });
    if (pinned) return;
    if (!hit) { hideCard(); return; }
    showCardFor(hit.item, pos, false);
  }

  function onClick(hit) {
    if (global.Author && global.Author.consumeClick(hit)) return;
    if (!hit) {
      pinned = false;
      BE.set({ selected: null });
      hideCard();
      refresh();
      return;
    }
    select(hit.ref, { followSheet: true });
  }

  function hideCard() {
    el.infocard.hidden = true;
    el.infocard.classList.remove('is-pinned');
  }

  function showCardFor(item, pos, isPinned) {
    if (!item) return;
    el.infocard.innerHTML = cardHTML(item);
    el.infocard.hidden = false;
    el.infocard.classList.toggle('is-pinned', !!isPinned);

    var stage = el.stage.getBoundingClientRect();
    var card = el.infocard.getBoundingClientRect();
    var x, y;
    if (pos) {
      x = pos[0] + 40;
      y = pos[1] + 18;
    } else if (BE.state.display === 'split') {
      // Both halves of a split are in use, so the pinned card sits low-left
      // rather than over the schematic pane.
      x = 30;
      y = stage.height - card.height - 60;
    } else {
      x = stage.width - card.width - 30;
      y = 30;
    }
    x = Math.max(10, Math.min(x, stage.width - card.width - 10));
    y = Math.max(10, Math.min(y, stage.height - card.height - 10));
    el.infocard.style.left = x + 'px';
    el.infocard.style.top = y + 'px';
  }

  function cardHTML(item) {
    var d = BE.state.assembly;
    var rows = [];
    var html = '';

    html += '<div class="infocard-head">' +
      '<span class="infocard-ref">' + esc(item.ref) + '</span>' +
      (item.signal ? '<span class="infocard-signal">' + esc(item.signal) + '</span>' : '') +
      '<span class="infocard-kind">' + esc(kindLabel(item)) + '</span></div>';

    if (item.hazard) {
      html += '<div class="hazard-strip">▲ ' + esc(item.hazard) +
        ' — power down before moving jumpers</div>';
    }

    html += '<div class="infocard-body">';

    if (item.isTestPoint) {
      if (item.isReturn) {
        html += '<div class="expect"><div class="expect-value">Reference point</div>' +
          '<div class="expect-range">Clip the meter\'s low lead here</div></div>';
      } else {
        var states = TP.states(item);
        var st = states[Math.min(stateIndex, states.length - 1)];
        if (st) {
          html += '<div class="expect">' +
            '<div class="expect-value">' + esc(TP.formatNominal(st, item.unit)) + '</div>' +
            '<div class="expect-range">Accept ' + esc(TP.formatRange(st, item.unit)) +
            (item.refPoint ? ' &nbsp;referenced to <b>' + esc(item.refPoint) + '</b>' : '') +
            '</div>' +
            (states.length > 1 ? '<div class="expect-range">' + esc(st.label) +
              ' — ' + states.length + ' modes, pick one in the panel</div>' : '') +
            (st.setup ? '<div class="expect-setup">Setup: ' + esc(st.setup) + '</div>' : '') +
            '</div>';
        }
      }
      if (item.rippleMaxPP != null) rows.push(['Ripple', '≤ ' + item.rippleMaxPP + ' V p-p']);
      if (item.ratedOutput) rows.push(['Rated', item.ratedOutput]);
      if (item.currentLimit) rows.push(['Current limit', item.currentLimit]);
      if (item.condition) rows.push(['Condition', item.condition]);
      // Only the two supply boards tabulate this. Everywhere else a test point
      // is a signal point -- A12's TP2 is OSC SENSE LO, A13's is the oscillator
      // output -- and calling those "Unregulated" states something the manual
      // never said about a thing that is not a supply at all.
      if (item.regulated != null) {
        rows.push(['Supply', item.regulated ? 'Regulated' : 'Unregulated']);
      }
    }

    // What the part does beats what it is, so it leads.
    if (item.function) rows.push(['Function', item.function]);
    if (item.desc) rows.push(['Description', item.desc]);
    if (item.fluke) rows.push(['Fluke P/N', item.fluke]);
    if (item.mfrPart) rows.push(['Mfr P/N', item.mfrPart + (item.mfrCode ? '  (' + item.mfrCode + ')' : '')]);
    if (item.asBuilt) {
      rows.push(['Rev 9 as built', item.asBuilt.desc + (item.asBuilt.fluke ? '  · ' + item.asBuilt.fluke : '')]);
    }
    var zones = (item.sch || []).map(function (s) {
      return s.sheet + (s.zone ? '/' + s.zone : '');
    });
    if (zones.length) rows.push(['Schematic', zones.join(', ')]);
    if (item.qty) rows.push(['Qty on board', String(item.qty)]);

    if (rows.length) {
      html += '<dl class="legend-rows">' + rows.map(function (r) {
        return '<dt>' + esc(r[0]) + '</dt><dd>' + esc(r[1]) + '</dd>';
      }).join('') + '</dl>';
    }

    var pills = [];
    if (item.esd) pills.push('<span class="pill warn">ESD sensitive</span>');
    if (item.inferred) pills.push('<span class="pill warn">Inferred value</span>');
    if (item.descOcr) pills.push('<span class="pill">OCR — verify</span>');
    var placement = placementPill(item);
    if (placement) pills.push(placement);
    if (Notes.has(d.id, item.ref)) {
      pills.push('<span class="pill ok">' + Notes.get(d.id, item.ref).length + ' note(s)</span>');
    }
    if (pills.length) html += '<div class="btn-row">' + pills.join(' ') + '</div>';

    if (item.note) html += '<div class="source-note">' + esc(item.note) + '</div>';
    if (item.source) html += '<div class="source-note">Source: ' + esc(item.source) + '</div>';

    html += '</div>';
    return html;
  }

  /**
   * Where the marker's position came from. A machine-read position that four
   * passes agreed on is a different claim from one a single pass produced, and
   * both differ from one a person placed; saying so is cheaper than being
   * wrong quietly.
   *
   * The third field marks the two tiers that are only ever reassurance — a
   * position a person checked, or one every pass read alike. That is a fact
   * about how the data was built, which is Author Mode's business; on the
   * bench it is noise on every part you click.
   *
   * The rest stay in plain sight for everyone, because they are not
   * bookkeeping but a warning that this marker may be in the wrong place, and
   * a wrong marker sends a probe to the wrong pad. Hiding those from the
   * person holding the probe would buy a tidier card with their safety.
   */
  var PLACEMENT = {
    verified:  ['ok',   'Position checked by hand', true],
    agreed:    ['',     'Position read from the drawing, passes agreed', true],
    ambiguous: ['warn', 'Position uncertain — passes disagreed'],
    single:    ['warn', 'Position from a single read — unconfirmed'],
    collision: ['warn', 'Position contested by another designator']
  };

  function placementPill(item) {
    // Neither of these is provenance: they say why nothing lights up on the
    // board when you pick this part, which is a fact about the part.
    if (item.notOnDrawing) {
      return '<span class="pill">Not on the drawing</span>';
    }
    if (!item.board) return '<span class="pill warn">Not placed</span>';
    var tier = PLACEMENT[item.placement] || PLACEMENT.agreed;
    if (tier[2] && !BE.state.author) return '';
    return '<span class="pill ' + tier[0] + '" title="' + esc(tier[1]) + '">' +
      esc(tier[1]) + '</span>';
  }

  function kindLabel(item) {
    if (item.isTestPoint) {
      return item.kind === 'hv-socket' ? 'HV test point'
        : (item.isReturn ? 'Return' : 'Test point');
    }
    var names = {
      cap: 'Capacitor', res: 'Resistor', diode: 'Diode', zener: 'Zener',
      transistor: 'Transistor', ic: 'IC', resnet: 'Resistor network', fuse: 'Fuse',
      jumper: 'Jumper', relay: 'Relay', mech: 'Mechanical', connector: 'Connector',
      switch: 'Switch', thermistor: 'Thermistor', varistor: 'Varistor',
      inductor: 'Inductor', transformer: 'Transformer', crystal: 'Crystal',
      socket: 'IC socket', wire: 'Wire',
      led: 'LED', battery: 'Battery'
    };
    return names[item.kind] || 'Part';
  }

  /* ================= panels ================= */

  var MICRO = '\u00b5';

  /**
   * Stop CSS uppercasing from turning µ into M.
   *
   * The panel's small labels are set in uppercase, and `text-transform:
   * uppercase` maps U+00B5 MICRO SIGN to U+039C GREEK CAPITAL LETTER MU --
   * which draws as a capital M. So "22.44 µF" came out of a measurement readout
   * as "22.44 MF", and on an instrument where the reading is the whole point,
   * a unit that silently becomes a thousand times larger is not a cosmetic
   * fault. (Check it anywhere: 'µF'.toUpperCase() is 'ΜF'.)
   *
   * There is no way to exempt one character in CSS, so the sign is wrapped in a
   * span that opts out of the transform. Doing it here, once, after the panel
   * is written, rather than at each place that formats a value: the uppercase
   * styling is applied by class and any label added later inherits it, so a fix
   * that depended on remembering to wrap at the call site would come undone the
   * first time someone printed a capacitance somewhere new. Only text nodes
   * that actually contain the sign are looked at, and only their parent's
   * computed style is read, so this is a handful of nodes per render.
   */
  function protectMicroSign(root) {
    if (!root) return;
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null, false);
    var doomed = [], node;
    while ((node = walker.nextNode())) {
      if (node.nodeValue.indexOf(MICRO) < 0) continue;
      var parent = node.parentNode;
      if (!parent || parent.nodeType !== 1) continue;
      if (global.getComputedStyle(parent).textTransform !== 'uppercase') continue;
      doomed.push(node);
    }
    doomed.forEach(function (text) {
      var frag = document.createDocumentFragment();
      text.nodeValue.split(MICRO).forEach(function (part, i) {
        if (i) {
          var keep = document.createElement('span');
          keep.className = 'lit';
          keep.textContent = MICRO;
          frag.appendChild(keep);
        }
        if (part) frag.appendChild(document.createTextNode(part));
      });
      text.parentNode.replaceChild(frag, text);
    });
  }

  function renderPanel() {
    var mode = BE.state.mode;
    if (mode === 'testpoints') renderTestPointsPanel();
    else if (mode === 'log') renderLogPanel();
    else if (mode === 'procedure') renderProcedurePanel();
    else if (mode === 'faults') renderFaultsPanel();
    else if (mode === 'recap') renderRecapPanel();
    else if (mode === 'author' && BE.state.author && global.Author) {
      el.panelBody.innerHTML = '';
      global.Author.renderInspector(el.panelBody);
    } else renderBoardPanel();
    renderDetailDock();
    protectMicroSign(el.panelBody);
    protectMicroSign(el.detailDockBody);
  }

  /**
   * The selected part's own pane, docked under the list.
   *
   * It used to be appended to the bottom of the panel body, which put it inside
   * the same scroller as the parts list: selecting a part or recording a
   * reading re-rendered that scroller and moved the list under the reader's
   * hand, right when they were reading it. Keeping it in its own element means
   * the list scrolls on its own and this stays put.
   *
   * Only the board and test point panels use it. The log, procedure and fault
   * panels are already about one thing at a time and have their own layout.
   */
  function renderDetailDock() {
    var dock = el.detailDock;
    if (!dock) return;
    var mode = BE.state.mode;
    var usesDock = mode !== 'log' && mode !== 'procedure' && mode !== 'faults';
    var sel = usesDock && BE.state.selected ? BE.lookup(BE.state.selected) : null;
    if (!sel) {
      dock.hidden = true;
      el.detailDockBody.innerHTML = '';
      return;
    }
    dock.hidden = false;
    el.detailDockTitle.textContent = sel.ref + ' — ' + (sel.signal || kindLabel(sel));
    el.detailDockBody.innerHTML = detailSection(sel);
    // Values typed before the pin count was corrected survive the rebuild.
    // Losing them would make fixing a wrong guess cost more than living with
    // it, which is the opposite of what an override is for.
    if (pendingPinValues && pendingPinRef === sel.ref) {
      applyPinValues(pendingPinValues.map(function (p) {
        return { pin: p.pin, v: p.v };
      }));
      pendingPinValues = null;
    }
    bindList([el.detailDockBody]);
    // A saved reading rebuilds this pane, which destroys the box just typed
    // into. Putting the caret back -- in the rebuilt box, which is empty, not
    // the old one -- is what keeps a sweep on the keyboard: value, Enter,
    // click the next point, value, Enter. Only ever after a save: focusing on
    // every selection would swallow the single-letter shortcuts.
    if (measureWantsFocus) {
      measureWantsFocus = false;
      var box = el.detailDockBody.querySelector('#measure-input');
      if (box) { box.focus(); box.select(); }
    }
    // Sizes as well as folds: which stops exist depends on the body that was
    // just built, so this has to run after it, not before.
    applyDockFold();
  }

  /**
   * Which stops this selection actually has.
   *
   * The middle one is the measurement box, so a part that has no box -- a
   * component, or a return point, which is a place to clip the black lead
   * rather than something to read -- offers the two it does have. Selecting
   * one of those does not write the preference down, only unfolds around it:
   * glancing at the return point mid-sweep and coming back to the next test
   * point comes back to the box. Folding by hand while one is selected is a
   * decision and does replace it.
   */
  function dockStops() {
    var hasBox = !!(el.detailDockBody && el.detailDockBody.querySelector('.measure'));
    return hasBox ? DOCK_FOLDS : ['full', 'collapsed'];
  }

  function effectiveFold() {
    return dockStops().indexOf(dockFold) >= 0 ? dockFold : 'full';
  }

  function cycleDockFold() {
    var stops = dockStops();
    setDockFold(stops[(stops.indexOf(effectiveFold()) + 1) % stops.length]);
  }

  function applyDockFold() {
    if (!el.detailDock) return;
    var fold = effectiveFold();
    var stops = dockStops();
    var next = stops[(stops.indexOf(fold) + 1) % stops.length];
    var says = { full: 'Show everything', measure: 'Fold to the measurement box',
                 collapsed: 'Collapse to the header' };
    el.detailDock.classList.toggle('is-collapsed', fold === 'collapsed');
    el.detailDock.classList.toggle('is-measure', fold === 'measure');
    // Not a boolean any more, but the two states a reader of the tree cares
    // about still are: the header alone, or something under it.
    el.detailDockToggle.setAttribute('aria-expanded', String(fold !== 'collapsed'));
    el.detailDockToggle.title = says[next] + ' (D)';
    applyDockHeight();
  }

  /**
   * How tall the dock is allowed to be.
   *
   * A dragged height wins over the stylesheet's cap, but never so far that the
   * parts list stops being a list -- the two share one column, and a dock that
   * can eat the whole of it is a worse problem than one that is too short.
   */
  function dockLimits() {
    var panelH = el.panelBody.parentNode.getBoundingClientRect().height;
    return { min: MIN_DOCK_H, max: Math.max(MIN_DOCK_H, panelH - MIN_LIST_H) };
  }

  function applyDockHeight() {
    if (!el.detailDock || el.detailDock.hidden) return;
    // A dragged height belongs to the full card only. The folded stops are as
    // tall as what is left in them, which is the point of folding.
    if (!dockHeight || effectiveFold() !== 'full') {
      el.detailDock.style.height = '';
      el.detailDock.style.maxHeight = '';
      return;
    }
    var lim = dockLimits();
    var h = Math.min(Math.max(dockHeight, lim.min), lim.max);
    el.detailDock.style.height = h + 'px';
    el.detailDock.style.maxHeight = 'none';
  }

  function setDockHeight(h, persist) {
    var lim = dockLimits();
    dockHeight = Math.min(Math.max(Math.round(h), lim.min), lim.max);
    applyDockHeight();
    if (persist) {
      try {
        global.localStorage.setItem(DOCK_H_KEY, String(dockHeight));
      } catch (err) { /* session-only is acceptable */ }
    }
  }

  function setDockFold(fold) {
    dockFold = fold;
    try {
      global.localStorage.setItem(DOCK_FOLD_KEY, fold);
      // Kept in step so a downgrade, or a second window still on the old
      // build, does not read a stale collapse out of the key it knows.
      global.localStorage.setItem(DOCK_KEY, fold === 'collapsed' ? '1' : '');
    } catch (err) { /* session-only is acceptable */ }
    applyDockFold();
  }

  function renderBoardPanel() {
    var d = BE.state.assembly;
    var q = el.searchInput.value.trim();
    var hits = Search.run(q);
    if (activeKind) {
      hits = hits.filter(function (h) { return matchesKind(h.item, activeKind); });
    }
    var html = '';
    var service = serviceIndex(d.id);
    if (serviceFilter) {
      hits = hits.filter(function (h) { return service.match(serviceFilter, h.item.ref); });
    }

    html += section('Component types', activeKind ? 'filtered' : '', kindLegendHTML());
    html += serviceFilterHTML(service);
    html += section('Results', hits.length + (q ? ' matching' : ' parts'),
      listHTML(hits.map(function (h) { return h.item; })));

    el.panelBody.innerHTML = html;
    bindList();
  }

  function renderTestPointsPanel() {
    var d = BE.state.assembly;
    var q = el.searchInput.value.trim();
    var html = '';

    if (q) {
      var hits = Search.run(q, { testPointsOnly: true });
      html += section('Matching test points', String(hits.length),
        listHTML(hits.map(function (h) { return h.item; })));
    } else {
      TP.byRail(d).forEach(function (group) {
        var rail = (d.rails || {})[group.id] || {};
        var body = listHTML(group.testpoints);
        if (rail.circuit) body += railCircuitHTML(rail.circuit);
        html += section(group.label, group.com ? 'COM ' + group.com : '', body);
      });
      // A board with no test points at all -- A4 ships none -- must say so.
      // An entirely blank panel does not distinguish "the manual publishes
      // nothing here" from "this failed to render".
      if (!html) {
        html = section('Test points', '',
          '<div class="empty"><strong>No test points</strong>The manual publishes ' +
          'no test points for ' + esc(d.id) + ' — its checks live on the Procedure ' +
          'and Fault codes tabs.</div>');
      }
    }
    el.panelBody.innerHTML = html;
    bindList();
  }

  function listHTML(items) {
    var d = BE.state.assembly;
    var verdicts = Log.verdicts(d.id);
    if (!items.length) {
      return '<div class="empty"><strong>Nothing matches</strong>Try a designator, a signal name like +17 SR, or a value like 3300UF.</div>';
    }
    return '<ul class="hitlist">' + items.map(function (item) {
      var v = verdicts[item.ref];
      var meta = item.isTestPoint
        ? (item.isReturn ? 'return' : shortExpect(item))
        : (item.fluke || '');
      // tabindex, because an li is not in the tab order on its own and these
      // rows are the main way into a part; Enter and Space land in bindList.
      return '<li data-ref="' + esc(item.ref) + '" tabindex="0"' +
        (BE.state.selected === item.ref ? ' class="is-selected"' : '') + '>' +
        (v ? '<span class="dot ' + v + '"></span>' :
          '<span class="swatch" style="background:' + markerColor(item, d) +
          (item.board ? '' : ';opacity:.35') + '"></span>') +
        '<span class="hit-ref">' + esc(item.ref) + '</span>' +
        '<span class="hit-desc">' + esc(item.signal || item.desc || '') + '</span>' +
        (Notes.has(d.id, item.ref) ? '<span class="note-badge">N</span>' : '') +
        '<span class="hit-meta">' + esc(meta) + '</span></li>';
    }).join('') + '</ul>';
  }

  /** What a rail is built from — the parts to suspect when it reads wrong. */
  function railCircuitHTML(circuit) {
    var groups = [
      ['Rectifier', circuit.rectifier],
      ['Filters', circuit.filters],
      ['Fuses', circuit.fuses],
      ['Regulators', circuit.regulators],
      ['Pull-ups', circuit.pullups],
      ['Level shift', circuit.level_shift],
      ['Relay', circuit.relay],
      ['Driver', circuit.driver]
    ].filter(function (g) { return g[1] && g[1].length; });

    return '<div class="field" style="padding:8px 12px">' +
      groups.map(function (g) {
        return '<span class="micro">' + esc(g[0]) + '</span>' +
          '<div class="chiprow" style="margin-bottom:6px">' +
          g[1].map(chipHTML).join('') + '</div>';
      }).join('') +
      (circuit.note ? '<div class="source-note" style="padding-left:0">' +
        esc(circuit.note) + '</div>' : '') + '</div>';
  }

  function shortExpect(tp) {
    var states = TP.states(tp);
    if (!states.length) return '';
    if (states.length > 1) return states.length + ' modes';
    return TP.formatNominal(states[0], tp.unit);
  }

  function detailSection(item) {
    var d = BE.state.assembly;
    var html = '';
    var body = '';

    if (item.isTestPoint && !item.isReturn) {
      // The box comes first and stays put while everything under it scrolls.
      // Checking a supply is one probe and a dozen test points, and the trip
      // to the Log tab and back for each of them was the whole cost of doing
      // it: the reading now goes in beside the limit it is judged against,
      // without leaving the list being worked down. measureHTML brings the
      // operating-mode select and the expected/accept line with it, so the
      // rows below no longer repeat them.
      body += measureHTML(item, true);
      var states = TP.states(item);
      var st = states[Math.min(stateIndex, states.length - 1)];
      if (st) {
        var rows =
          (st.setup ? '<dt>Setup</dt><dd>' + esc(st.setup) + '</dd>' : '') +
          (st.source ? '<dt>Source</dt><dd>' + esc(st.source) + '</dd>' : '');
        if (rows) body += '<dl class="legend-rows">' + rows + '</dl>';
        if (st.onFail && st.onFail.length) {
          body += '<div class="field"><span class="micro">If out of tolerance, check</span>' +
            '<div class="chiprow">' + st.onFail.map(chipHTML).join('') + '</div></div>';
        }
      }
    }

    // Record reading stood here and its only job was to change tabs. The box
    // it sent you to is now directly above, so the row can come out empty --
    // and an empty row is a stray rule across the card, so it is not emitted.
    var jumps =
      (item.board ? '<button class="btn" data-act="show-board">Show on board</button>' : '') +
      ((item.sch || []).length ? '<button class="btn" data-act="show-sch">Show on schematic</button>' : '');
    if (jumps) body += '<div class="btn-row">' + jumps + '</div>';

    if (!item.isTestPoint) body += componentServiceHTML(item);

    body += notesHTML(d.id, item.ref);

    var history = Log.history(d.id, item.ref);
    // Pin sweeps have their own block, with the comparison against the
    // previous one that is the reason to take them; folding them in here as a
    // single number would have to invent one.
    var plain = history.filter(function (h) { return h.reading.target !== 'pins'; });
    if (plain.length) {
      body += '<div class="micro" style="padding:6px 12px 2px">History</div>' +
        '<table class="readings"><tbody>' + plain.slice(-6).reverse().map(function (h) {
          return '<tr><td>' + esc(h.reading.at.slice(0, 10)) + '</td>' +
            '<td class="num">' + TP.fmt(h.reading.measured) + ' ' + esc(h.reading.unit) + '</td>' +
            '<td class="num v-' + h.reading.verdict + '">' +
            (h.reading.pctOffNominal == null ? '—' : h.reading.pctOffNominal.toFixed(1) + '%') +
            '</td></tr>';
        }).join('') + '</tbody></table>';
    }

    // No header of its own. The dock's own header already names the part, and
    // the repeat cost a row of a pane that is meant to be usable dragged down
    // to a couple of inches; the kind that used to sit in it has moved up
    // there instead. detailSection has only ever been rendered into the dock.
    html += '<section class="panel-section">' + body + '</section>';
    return html;
  }

  function chipHTML(ref) {
    var item = BE.lookup(ref);
    return '<button class="chip' + (item && item.isTestPoint ? ' tp' : '') +
      '" data-ref="' + esc(ref) + '">' + esc(ref) + '</button>';
  }

  /**
   * Measuring a component, and recording what happened to it.
   *
   * Both live on the part's own card rather than in the Log tab, because both
   * are things you do with a probe in one hand while looking at the part. The
   * parts-list value is shown whether or not it can be scored: seeing "4.7 kΩ
   * ±1%" beside the box you are typing into is most of the value, and a
   * verdict only appears when the description was unambiguous enough to trust.
   */
  /**
   * What this unit's service history says about each part of this board,
   * gathered once so the filter chips and the list can both read it.
   */
  function serviceIndex(assembly) {
    var repairs = Log.repairIndex(assembly);
    var measured = Log.measuredIndex(assembly);
    var noted = {};
    Notes.annotated(assembly).forEach(function (ref) { noted[ref] = true; });
    return {
      repairs: repairs, measured: measured, noted: noted,
      match: function (filter, ref) {
        if (filter === 'faulty') return repairs[ref] === 'faulty' || repairs[ref] === 'suspect';
        if (filter === 'replaced') return repairs[ref] === 'replaced';
        if (filter === 'measured') return !!measured[ref];
        if (filter === 'noted') return !!noted[ref];
        return true;
      },
      count: function (filter) {
        var n = 0;
        var refs = filter === 'measured' ? Object.keys(measured)
                 : filter === 'noted' ? Object.keys(noted) : Object.keys(repairs);
        refs.forEach(function (ref) { if (this.match(filter, ref)) n++; }, this);
        return n;
      }
    };
  }

  /**
   * The repair log as a filter over the board. Nothing is shown when there is
   * no history yet: an empty row of chips reading "0 faulty, 0 replaced" is a
   * permanent reminder of a feature rather than a way into anything.
   */
  function serviceFilterHTML(service) {
    var chips = [
      { id: 'faulty', label: 'Faulty or suspect' },
      { id: 'replaced', label: 'Replaced' },
      { id: 'measured', label: 'Measured' },
      { id: 'noted', label: 'Annotated' }
    ].filter(function (c) { return service.count(c.id) > 0; });
    if (!chips.length) return '';
    return section('Service history', serviceFilter ? 'filtered' : '',
      '<div class="chiprow" style="padding:8px 12px">' +
      chips.map(function (c) {
        return '<button class="chip' + (serviceFilter === c.id ? ' is-active' : '') +
          '" data-service="' + esc(c.id) + '">' + esc(c.label) +
          ' <b>' + service.count(c.id) + '</b></button>';
      }).join('') +
      (serviceFilter ? '<button class="chip" data-service="">Clear</button>' : '') +
      '</div>');
  }

  /**
   * Pin voltages on an IC or a transistor.
   *
   * Nothing published says what a pin should read, so this records rather than
   * judges. What makes the numbers usable later is the pair of things around
   * them: the condition they were taken in, and the previous sweep to compare
   * against -- which is exactly how these get used in practice, a sweep before
   * a part is pulled and another after it is replaced.
   *
   * Blank means not measured. Most sweeps are partial, and a blank that stored
   * as 0 V would be a claim nobody made.
   */
  function pinSweepHTML(item) {
    var pc = Parts.pinCount(item);
    if (!pc) return '';
    var d = BE.state.assembly;
    var last = Log.lastPins(d.id, item.ref);
    // A correction made in this session wins while it is being typed; after
    // that the last saved sweep carries it, and only then the parts list.
    if (pendingPinRef !== item.ref) {
      pendingPinRef = item.ref;
      pendingPinCount = null;
      pendingPinValues = null;
    }
    var n = pendingPinCount || (last && last.pinCount) || pc.n;
    var why = pendingPinCount ? 'set by you for this sweep'
      : last && last.pinCount ? 'from your last sweep of this part'
      : pc.source === 'stated' ? 'from the parts list'
      : pc.source === 'package' ? 'transistors are three-lead unless you say otherwise'
      : 'a guess — the parts list does not say. Correct it if it is wrong.';

    var html = '<div class="micro pin-head" style="padding:10px 12px 2px">Pin voltages' +
      '<span class="pin-count-wrap">' +
      '<input id="pin-count" type="number" min="2" max="64" step="1" value="' + n + '">' +
      '<span class="dim">pins</span></span></div>';
    html += '<div class="pin-why micro dim">' + esc(why) + '</div>';

    html += '<div class="pin-meta">' +
      '<input id="pin-condition" type="text" placeholder="condition — e.g. idle STBY, A12/A13 out"' +
      (last ? ' value="' + esc(last.condition || '') + '"' : '') + '>' +
      '<input id="pin-ref" type="text" placeholder="vs" title="Reference point" value="' +
      esc((last && last.refPoint) || defaultReturnRef(d) || '') + '">' +
      '</div>';

    html += '<div class="pin-grid" id="pin-grid">' +
      pinCellsHTML(n, last ? pinMap(last) : null) + '</div>';
    html += '<div class="pin-hint micro dim">Enter moves to the next pin. ' +
      'Paste a list like <code>1: 0.45</code> into any cell to fill several at once.</div>';
    html += '<div class="btn-row">' +
      '<button class="btn primary" data-act="record-pins">Save pin sweep</button>' +
      '<button class="btn" data-act="clear-pins">Clear</button></div>';

    html += pinHistoryHTML(d.id, item.ref);
    return html;
  }

  /**
   * The cells of the pin grid, on their own so that correcting the pin count
   * can replace the grid without replacing anything around it.
   */
  function pinCellsHTML(n, prev) {
    var cells = '';
    for (var i = 1; i <= n; i++) {
      var was = prev && prev[i] != null ? prev[i] : null;
      cells += '<label class="pin-cell"><span class="pin-no">' + i + '</span>' +
        '<input class="pin-v" type="text" inputmode="decimal" data-pin="' + i + '"' +
        ' autocomplete="off" spellcheck="false">' +
        (was == null ? '' : '<span class="pin-was" title="last sweep">' +
          esc(TP.fmt(was)) + '</span>') +
        '</label>';
    }
    return cells;
  }

  function pinMap(reading) {
    var out = {};
    (reading.pins || []).forEach(function (p) { out[p.pin] = p.v; });
    return out;
  }

  /** The board's own return point, so the reference field starts filled in. */
  function defaultReturnRef(d) {
    var ret = (d.testpoints || []).find(function (t) { return t.isReturn; });
    return ret ? ret.ref : null;
  }

  /**
   * Past sweeps, newest first, with the change from the one before it.
   *
   * The delta is the point: a pin that moved from -8.2 V to 0 V after a part
   * was replaced is the whole story, and reading it off two lists by eye is
   * how it gets missed.
   */
  function pinHistoryHTML(assembly, ref) {
    var sweeps = Log.history(assembly, ref)
      .filter(function (h) { return h.reading.target === 'pins'; })
      .map(function (h) { return h.reading; });
    if (!sweeps.length) return '';
    var html = '<div class="micro" style="padding:10px 12px 2px">Previous sweeps</div>';
    for (var i = sweeps.length - 1; i >= 0; i--) {
      var r = sweeps[i];
      var before = i > 0 ? pinMap(sweeps[i - 1]) : null;
      var pins = (r.pins || []).map(function (p) {
        var delta = before && before[p.pin] != null ? p.v - before[p.pin] : null;
        var moved = delta != null && Math.abs(delta) > 1e-9;
        return '<span class="pin-read' + (moved ? ' moved' : '') + '"' +
          (moved ? ' title="' + esc('was ' + TP.fmt(before[p.pin]) + ' V') + '"' : '') +
          '><b>' + p.pin + '</b>' + esc(TP.fmt(p.v)) + '</span>';
      }).join('');
      html += '<div class="pin-sweep">' +
        '<div class="pin-sweep-head micro">' + esc(r.at.slice(0, 16).replace('T', ' ')) +
        (r.condition ? ' · ' + esc(r.condition) : '') +
        (r.refPoint ? ' · vs ' + esc(r.refPoint) : '') +
        ' <button class="linkish" data-act="del-pins" data-id="' + esc(r.id) + '">remove</button>' +
        '</div><div class="pin-reads">' + pins + '</div></div>';
    }
    return html;
  }

  function componentServiceHTML(item) {
    var d = BE.state.assembly;
    var spec = Parts.spec(item);
    var quantities = Parts.quantitiesFor(item);
    // The sticky choice belongs to the part it was made on. Carried across a
    // new selection it silently overrode that part's own spec: measure a
    // resistor in ohms, click a capacitor, and the box still said resistance
    // with ohms as its unit while the line beneath read "3.3 µF +30/−20%" --
    // and a value entered there stored as a resistance with no spec and no
    // warning.
    if (measureQuantityRef !== item.ref) measureQuantity = null;
    measureQuantityRef = item.ref;
    var chosen = measureQuantity || (spec ? spec.quantity : quantities[0].id);
    var units = Parts.units(chosen);
    var html = '<div class="micro" style="padding:10px 12px 2px">Measure</div>';

    html += '<div class="measure-grid">' +
      '<select id="cq-quantity">' + quantities.map(function (q) {
        return '<option value="' + esc(q.id) + '"' + (q.id === chosen ? ' selected' : '') +
          '>' + esc(q.label) + '</option>';
      }).join('') + '</select>' +
      '<input id="cq-value" type="text" inputmode="decimal" placeholder="measured">' +
      '<select id="cq-unit">' + units.map(function (u) {
        return '<option value="' + esc(u) + '"' +
          (spec && spec.unit === u ? ' selected' : '') + '>' + esc(u || '—') + '</option>';
      }).join('') + '</select></div>';

    html += '<label class="inline-check"><input type="checkbox" id="cq-incircuit" checked> ' +
      'measured in circuit</label>';

    if (spec) {
      html += '<dl class="legend-rows"><dt>Parts list</dt><dd>' + esc(spec.display) +
        (Parts.toleranceText(spec) ? ' ' + esc(Parts.toleranceText(spec)) : '') +
        '</dd></dl>';
    }
    // The same ESR guidance the Recap round gives, for anyone who measures a
    // capacitor from the board rather than from that mode.
    var esrLim = global.Caps ? Caps.esrLimit(item) : null;
    if (esrLim) {
      var isAl = Caps.type(item) === 'AL';
      html += '<dl class="legend-rows"><dt>ESR</dt><dd title="' +
        esc('Derived from ' + esrLim.basis) + '">' +
        (isAl ? 'well under ' : 'about ') +
        esc(esrLim.maxESR.toFixed(esrLim.maxESR < 1 ? 3 : 1)) + ' Ω' +
        '<br><span class="dim">' + (isAl
          ? 'gross upper limit — past it the electrolyte has gone'
          : 'reference figure; tantalum ESR does not drift with age') +
        '</span></dd></dl>';
    }
    html += '<div class="btn-row">' +
      '<button class="btn primary" data-act="record-component">Record measurement</button>' +
      '</div>';

    html += pinSweepHTML(item);

    // What has already happened to this part, on this instrument, ever.
    var repairs = Log.repairs(d.id).filter(function (r) { return r.ref === item.ref; });
    if (repairs.length) {
      html += '<div class="micro" style="padding:8px 12px 2px">This part</div>';
      html += repairs.map(function (r) {
        var fitted = r.fitted || {};
        return '<div class="repair-line s-' + esc(r.status) + '">' +
          '<span class="tag t-' + esc(r.status) + '">' + esc(r.status) + '</span> ' +
          esc(r.at.slice(0, 10)) +
          (r.symptom ? ' · ' + esc(r.symptom) : '') +
          (r.status === 'replaced' && fitted.desc
            ? '<div class="micro">fitted: ' + esc(fitted.desc) +
              (fitted.substitute ? ' (substitute)' : '') + '</div>' : '') +
          '<button class="note-del" data-repair="' + esc(r.id) + '" title="Remove">×</button>' +
          '</div>';
      }).join('');
    }
    if (pendingRepair && pendingRepair.ref === item.ref) {
      html += repairFormHTML(item, pendingRepair.status);
    } else {
      html += '<div class="btn-row">' +
        '<button class="btn" data-act="mark" data-status="suspect">Mark suspect</button>' +
        '<button class="btn" data-act="mark" data-status="faulty">Mark faulty</button>' +
        '<button class="btn" data-act="mark" data-status="replaced">Replaced…</button>' +
        '</div>';
    }
    return html;
  }

  /**
   * The form for recording what was wrong and what went in.
   *
   * What came out is prefilled from the parts list, because it is known: the
   * manual says what is meant to be there and it is right far more often than
   * not. What went in starts as a copy of it, since fitting the specified part
   * is the normal case and correcting one field beats typing four.
   */
  function repairFormHTML(item, status) {
    var words = { suspect: 'Mark suspect', faulty: 'Mark faulty', replaced: 'Record replacement' };
    var html = '<div class="micro" style="padding:10px 12px 2px">' +
      esc(words[status] || status) + '</div>';
    html += '<div class="field"><span class="micro">Symptom</span>' +
      '<input id="rp-symptom" placeholder="shorted, open, ESR 4.2 Ω, drifted high…"></div>';
    if (status === 'replaced') {
      html += '<div class="field"><span class="micro">Removed</span>' +
        '<input id="rp-removed" value="' + esc(item.desc || '') + '"></div>';
      // data-prefill records what the parts list put here. It is not something
      // anyone typed, so a remembered substitute may replace it -- whereas a
      // value that has been edited is left alone. Without this the hint could
      // never fill these two, because they are never empty.
      html += '<div class="field"><span class="micro">Fitted</span>' +
        '<input id="rp-fitted" data-prefill="' + esc(item.desc || '') +
        '" value="' + esc(item.desc || '') + '"></div>';
      html += '<div class="field-row">' +
        '<div class="field"><span class="micro">Fluke P/N</span>' +
        '<input id="rp-fluke" data-prefill="' + esc(item.fluke || '') +
        '" value="' + esc(item.fluke || '') + '"></div>' +
        '<div class="field"><span class="micro">Mfr P/N</span>' +
        '<input id="rp-mfr" list="fitted-parts" autocomplete="off" value="' +
        esc(item.mfrPart || '') + '"></div></div>';
      html += fittedDatalistHTML('fitted-parts') +
        '<div class="fitted-hint" id="rp-mfr-hint"></div>';
      html += '<label class="inline-check"><input type="checkbox" id="rp-sub"> ' +
        'not the specified part (substitute)</label>';
    }
    html += '<div class="btn-row">' +
      '<button class="btn primary" data-act="save-repair" data-status="' + esc(status) +
      '">Save</button>' +
      '<button class="btn" data-act="cancel-repair">Cancel</button></div>';
    return html;
  }

  function notesHTML(assembly, ref) {
    var notes = Notes.get(assembly, ref);
    // Every control carries the ref this block was rendered for. In Recap
    // mode the block appears twice at once -- in the open row and in the
    // dock -- and the row stays open while the selection moves, so a handler
    // that reached for BE.state.selected could file a note against a
    // different part, or against null after a click on empty board.
    var html = '<div class="micro" style="padding:8px 12px 2px">Notes</div>';
    html += notes.map(function (n) {
      return '<div class="note"><div class="note-meta">' +
        esc(n.at.slice(0, 16).replace('T', ' ')) +
        (n.author ? ' · ' + esc(n.author) : '') +
        '<button class="note-del" data-note="' + n.id + '" data-ref="' + esc(ref) +
        '" title="Delete note">×</button>' +
        '</div><div class="note-text">' + esc(n.text) + '</div></div>';
    }).join('');
    html += '<div class="field"><textarea id="note-input" rows="2" ' +
      'placeholder="Add a note — replaced part, measured value, anything to remember"></textarea></div>' +
      '<div class="btn-row"><button class="btn" data-act="add-note" data-ref="' + esc(ref) +
      '">Add note</button></div>';
    return html;
  }

  /**
   * The one line that keeps the two serials apart.
   *
   * The tool asks for a serial in two places and they name different objects:
   * the picker in the top bar names the calibrator, the field below names the
   * board fitted to it. Nothing on screen used to say so, and two unlabelled
   * serial boxes read as one asked twice -- which is how a board serial ends up
   * typed into the instrument, where it is wrong in a way nothing catches.
   * So state the scope of each, and point at where the other one is set.
   */
  function unitScopeHTML(d) {
    var unit = Units.active();
    var serial = unit && (unit.serial || '').trim();
    return '<div class="scope-note micro">Instrument ' +
      (serial ? '<b>' + esc(serial) + '</b>' : '<span class="dim">not named yet</span>') +
      '<span class="dim"> — set in the top bar. Below: the ' + esc(d.id) +
      ' board fitted to it right now.</span></div>';
  }

  var FIT_WORDS = { fitted: 'fitted', removed: 'out', swapped: 'swapped' };

  function stamp(iso) {
    return iso ? String(iso).slice(0, 16).replace('T', ' ') : '';
  }

  /**
   * The header count, which says the one thing worth seeing without looking:
   * whether anything is out. A complete instrument needs no elaboration.
   */
  function fittedSummary() {
    var state = Log.fitmentState();
    var out = [], swapped = 0, known = 0;
    Object.keys(state).forEach(function (id) {
      known++;
      if (state[id].state === 'removed') out.push(id);
      if (state[id].state === 'swapped') swapped++;
    });
    if (!known) return '';
    var bits = [];
    if (out.length) bits.push(out.sort(byBoardNumber).join(', ') + ' out');
    if (swapped) bits.push(swapped + ' swapped');
    return bits.length ? bits.join(' · ') : 'all fitted';
  }

  function byBoardNumber(a, b) {
    return parseInt(a.replace(/^\D+/, ''), 10) - parseInt(b.replace(/^\D+/, ''), 10);
  }

  /**
   * What is plugged into the instrument, and the record of it changing.
   *
   * Boards come out during a repair — to isolate a fault, or because a suspect
   * one is being swapped for a known-good to see whether the symptom follows
   * it. That configuration is part of every reading taken in it, and this
   * log's owner has been writing it into notes by hand: "idle STBY (A12/A13
   * absent, A15-A18 present)".
   *
   * A board nobody has spoken about shows no state at all, rather than an
   * unticked box. "Not said" and "removed" are different claims, and only one
   * of them is true of a board that has simply never been touched.
   */
  function fitmentHTML() {
    var state = Log.fitmentState();
    var history = Log.fitmentLog();
    // A daughter card soldered to its parent, or the rear panel itself, is
    // not something that comes out on the bench, so it gets no row: a tick
    // box for it could only ever record a state the board cannot be in.
    var rows = BE.list().filter(function (d) { return !d.fixed; }).map(function (d) {
      var e = state[d.id];
      // A board nobody has spoken about is drawn ticked, because a calibrator
      // normally has all of them in and the act being recorded here is pulling
      // one out. Drawn unticked, the first click on the board you are about to
      // remove would mark it fitted -- the opposite of the intent. The state
      // column still reads "—" until something is actually recorded, and the
      // report lists only what was recorded, so a tick nobody made never
      // becomes a claim that the board was checked and present.
      var on = e ? e.state !== 'removed' : true;
      var known = !!e;
      return '<label class="fit-row' + (known ? '' : ' is-unknown') +
        (e && e.state === 'removed' ? ' is-out' : '') +
        (e && e.state === 'swapped' ? ' is-swapped' : '') + '">' +
        '<input type="checkbox" data-act="fit-toggle" data-id="' + esc(d.id) + '"' +
        (on ? ' checked' : '') + '>' +
        '<span class="fit-id">' + esc(d.id) + '</span>' +
        '<span class="fit-name">' + esc(d.name) + '</span>' +
        '<span class="fit-state">' + (known ? esc(FIT_WORDS[e.state] || e.state) : '—') + '</span>' +
        '<button class="fit-swap" data-act="fit-swap" data-id="' + esc(d.id) + '" type="button" ' +
        'title="Record that this slot now holds a different board">swap</button>' +
        '</label>';
    }).join('');

    var log = history.length
      ? '<ul class="fit-log">' + history.slice(0, 12).map(function (e) {
          return '<li><span class="fit-when">' + esc(stamp(e.at)) + '</span> ' +
            '<b>' + esc(e.assembly) + '</b> ' + esc(FIT_WORDS[e.state] || e.state) +
            (e.note ? ' <span class="dim">— ' + esc(e.note) + '</span>' : '') +
            '<button class="linkish" data-act="fit-undo" data-id="' + esc(e.id) +
            '" title="Remove this entry">×</button></li>';
        }).join('') + '</ul>'
      : '<div class="empty"><strong>Nothing recorded yet</strong>' +
        'Tick a board as you pull or refit it. What was out when a reading was ' +
        'taken is part of the reading.</div>';

    // Ticking a board rebuilds this panel, so the note carries its typed
    // value across: a "why" written for a multi-board pull has to survive the
    // first tick to cover the second.
    var noteNow = (document.getElementById('fit-note') || {}).value || '';
    return '<div class="fit-note-row"><input id="fit-note" ' +
      'placeholder="why — e.g. out to isolate the ohms fault" value="' + esc(noteNow) + '">' +
      '</div><div class="fit-grid">' + rows + '</div>' +
      '<div class="fit-log-head micro dim">Changes</div>' + log;
  }

  function renderLogPanel() {
    var d = BE.state.assembly;
    var session = Log.active();
    var html = '';

    if (!session || session.assembly !== d.id) {
      // The serial box answers for the active unit. Once the unit has a
      // serial the box shows it and will not take another: units are matched
      // on serial, so a different one typed here used to be dropped without
      // a word -- the visit recorded one serial and the unit kept the other.
      // Read-only with the source named beats silently ignored; correcting a
      // serial is the ✎ by the picker's job.
      var startUnit = Units.active();
      var startSerial = startUnit ? String(startUnit.serial || '').trim() : '';
      html += section('Session', '',
        '<div class="empty"><strong>No open session</strong>' +
        'Start one to record readings against ' + esc(d.id) + '.</div>' +
        '<div class="field"><span class="micro">Instrument serial' +
        (startSerial ? ' — this unit’s' : '') + '</span>' +
        '<input id="meta-serial"' +
        (startSerial
          ? ' value="' + esc(startSerial) + '" readonly title="The active ' +
            'unit’s serial — change it with the ✎ beside the unit picker"'
          : ' placeholder="e.g. 5545001"') + '></div>' +
        '<div class="field"><span class="micro">Technician</span><input id="meta-tech"></div>' +
        '<div class="btn-row"><button class="btn primary" data-act="start-session">Start session</button>' +
        '<button class="btn" data-act="import-log">Import log</button></div>');
      html += section('Instrument configuration', fittedSummary(), fitmentHTML());
      el.panelBody.innerHTML = html;
      bindList();
      return;
    }

    var sum = Log.summary(session);
    html += section('Session', session.startedAt.slice(0, 16).replace('T', ' '),
      '<div class="summary-strip">' +
      '<span class="v-pass">✔ <b>' + sum.pass + '</b> pass</span>' +
      '<span class="v-marginal">◑ <b>' + sum.marginal + '</b> marginal</span>' +
      '<span class="v-fail">✘ <b>' + sum.fail + '</b> fail</span>' +
      '<span class="spacer"></span><span>' + sum.total + ' readings</span></div>' +
      // Two serials, two objects, and the panel now says which is which. The
      // one in the top bar names the calibrator. These name the physical board
      // fitted to it, which is a different fact: a PCA is field-replaceable,
      // and swapping a suspect board for a known-good one is the fastest way
      // to tell whether a fault lives on the board or in what feeds it. Six
      // months on, a reading filed against "A16" says which design was
      // measured and never which object. The revision matters for the same
      // reason a limit does -- Fluke changed values between revs, so a limit
      // that applies to one board need not apply to the next.
      unitScopeHTML(d) +
      '<div class="field-row">' +
      '<div class="field"><span class="micro">' + esc(d.id) + ' board serial</span>' +
      '<input data-meta="assemblySerial" placeholder="stamped on the PCA" value="' +
      esc(session.assemblySerial || '') + '"></div>' +
      '<div class="field field-narrow"><span class="micro">Board rev</span>' +
      '<input data-meta="assemblyRev" placeholder="' + esc(d.rev || 'e.g. B') + '" value="' +
      esc(session.assemblyRev || '') + '"></div></div>' +
      '<div class="field-row">' +
      '<div class="field"><span class="micro">Technician</span>' +
      '<input data-meta="technician" value="' + esc(session.technician) + '"></div>' +
      '<div class="field"><span class="micro">Meter</span>' +
      '<input data-meta="meter" value="' + esc(session.meter) + '"></div></div>' +
      '<div class="field-row">' +
      '<div class="field"><span class="micro">Line / ambient</span>' +
      '<input data-meta="ambient" value="' + esc(session.ambient) + '"></div></div>');

    var sel = BE.state.selected ? BE.lookup(BE.state.selected) : null;
    if (sel && sel.isTestPoint && !sel.isReturn) {
      html += section('Measure ' + sel.ref, sel.signal || '', measureHTML(sel));
    } else if (sel) {
      // Not "click it on the board": this mode strips component markers from
      // the board, so the instruction as written could not be followed. The
      // missing step is going back to the Board tab, where the card lives.
      html += section('Measure ' + sel.ref, sel.desc || '',
        '<div class="source-note" style="padding:6px 12px 0">Component measurements ' +
        'and repairs are recorded on the part&rsquo;s own card — open the Board tab ' +
        '(B) and its card comes up in the dock.</div>');
    } else {
      html += section('Measure', '',
        '<div class="empty"><strong>Pick a part or a test point</strong>' +
        'Click one on the board, or search for it, to record against it.</div>');
    }

    html += section('Instrument configuration', fittedSummary(), fitmentHTML());

    html += section('Readings', String(session.readings.length),
      session.readings.length ? readingsTable(session) :
        '<div class="empty">Nothing recorded yet.</div>');

    // Every repair on this board of this instrument, not just this visit: what
    // matters when a board comes back is what has ever been done to it.
    var repairs = Log.repairs(d.id);
    html += section('Session notes', String((session.log || []).length),
      sessionNotesHTML(session));

    html += section('Repair log', String(repairs.length),
      repairs.length ? repairsTable(repairs) :
        '<div class="empty">No parts marked faulty or replaced on ' + esc(d.id) + '.</div>');

    html += '<div class="btn-row">' +
      '<button class="btn primary" data-act="export-report">Service report</button>' +
      '<button class="btn" data-act="export-json">Export log</button>' +
      '<button class="btn" data-act="export-csv">CSV</button></div>';
    html += '<div class="btn-row">' +
      '<button class="btn" data-act="import-log">Open a log…</button>' +
      '<button class="btn" data-act="export-all-units">Export every unit</button>' +
      '<button class="btn" data-act="new-session">New session</button></div>';
    html += '<div class="source-note" style="padding:2px 12px 10px">' +
      'One file carries this unit&rsquo;s readings, repairs and notes together. ' +
      'Opening a log merges it in and never replaces what is already here.</div>';

    el.panelBody.innerHTML = html;
    bindList();
    // Arriving at this panel with a point selected should put the cursor in the
    // box. Re-rendering while someone is typing somewhere else should not: the
    // search field re-renders this panel on every keystroke, so this used to
    // take the caret away after the first character and drop the rest of what
    // was being typed into the measurement box. A search for "+5 LHR" left "+"
    // in the search field and "5 LHR" one click away from being recorded as a
    // reading.
    var input = document.getElementById('measure-input');
    var busy = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
    if (input && !busy) { input.focus(); input.select(); }
  }

  /**
   * What a point should read, what it does read, and how far apart those are.
   *
   * One builder for the Log tab and for the detail dock, because it is the
   * same job in both: nothing here knows which panel it landed in. `compact`
   * is the dock, where the block is pinned to the top of a pane that may be
   * only a few lines tall -- there the setup note moves down into the rows
   * that scroll, rather than pushing the box being typed into off the pane.
   *
   * Only one of these exists at a time, which is what lets it keep fixed ids:
   * the dock is hidden in log mode, so #measure-input is never ambiguous.
   */
  function measureHTML(tp, compact) {
    var states = TP.states(tp);
    var st = states[Math.min(stateIndex, states.length - 1)];
    var html = '<div class="measure' + (compact ? ' is-compact' : '') + '">';
    if (states.length > 1) {
      html += '<div class="field" style="padding:0 0 8px"><span class="micro">Operating mode</span>' +
        '<select id="state-select">' + states.map(function (s, i) {
          return '<option value="' + i + '"' + (i === stateIndex ? ' selected' : '') + '>' +
            esc(s.label) + '</option>';
        }).join('') + '</select></div>';
    }
    if (st && st.setup && !compact) {
      html += '<div class="expect-setup" style="margin-bottom:8px">Setup: ' + esc(st.setup) + '</div>';
    }
    html += '<div class="micro" style="margin-bottom:4px">Expected ' +
      esc(TP.formatNominal(st, tp.unit)) + ' · accept ' + esc(TP.formatRange(st, tp.unit)) +
      (tp.refPoint ? ' · ref ' + esc(tp.refPoint) : '') + '</div>';
    // The placeholder must not read as a number: blank means unmeasured, and
    // a box apparently holding "0.000" undercuts that promise at a glance.
    html += '<div class="measure-input"><input id="measure-input" type="text" inputmode="decimal" ' +
      'placeholder="measured" autocomplete="off"><span class="measure-unit">' +
      esc(tp.unit || 'V') + '</span>' +
      '<button class="btn primary" data-act="save-reading">Save</button></div>';
    html += '<div id="verdict-slot">' + slotHTML(tp, st, '') + '</div>';
    html += '</div>';
    return html;
  }

  /**
   * What goes under the box: the reading being typed, or the one already
   * filed, or neither.
   *
   * Saving clears the box, and an empty box used to take the verdict with it
   * -- the answer to "did that pass?" vanished at the moment it was earned,
   * leaving the toast, which is gone in two and a half seconds. So the filed
   * reading holds the slot until a new number displaces it, and clearing the
   * box brings it back rather than blanking the slot.
   */
  function slotHTML(tp, st, raw) {
    var typed = readNumber(raw);
    if (!isNaN(typed)) return verdictHTML(tp, st, typed, null);
    var held = heldReading(tp, Math.min(stateIndex, TP.states(tp).length - 1));
    return verdictHTML(tp, st, held ? held.measured : NaN, held);
  }

  /**
   * The reading already filed for this point, this visit, this mode.
   *
   * This visit only, deliberately. The slot speaks in the present tense --
   * it is what you just did with the probe -- and a value from a service call
   * six months ago is not that. The older ones are in History, directly below.
   *
   * The stored mode is clamped the same way the displayed one is, so a reading
   * filed against a mode index the point no longer offers still lines up with
   * the state actually on screen instead of quietly never matching.
   */
  function heldReading(tp, idx) {
    var session = sessionHere();
    if (!session) return null;
    var n = TP.states(tp).length;
    var found = null;
    session.readings.forEach(function (r) {
      if (r.ref !== tp.ref || typeof r.measured !== 'number') return;
      if (Math.min(r.stateIndex || 0, n - 1) !== idx) return;
      if (!found || r.at > found.at) found = r;
    });
    return found;
  }

  /**
   * The tolerance band, and where a reading falls in it.
   *
   * `measured` may be NaN, which is the ordinary case rather than an error:
   * nothing typed and nothing filed means the band is drawn with its scale and
   * no needle -- worth seeing on its own, because it is the window you aim the
   * probe at. A point the manual publishes no limit for gets nothing at all:
   * there is no window to draw, and an unscaled bar would invent one.
   *
   * `held` is the filed reading when the value came from the log rather than
   * from the box. It is marked, because an empty box beside a live-looking
   * verdict would otherwise read as a measurement happening now.
   */
  function verdictHTML(tp, st, measured, held) {
    var range = TP.range(st);
    if (!range) return '';
    var res = TP.evaluate(st, measured);
    var html = '';
    var needle = '';
    if (res) {
      var words = { pass: 'In tolerance', marginal: 'Near limit', fail: 'Out of tolerance' };
      var pct = res.pctOffNominal == null ? '' : ' · ' + res.pctOffNominal.toFixed(2) + '%';
      html +=
        '<div class="verdict-readout ' + res.verdict + (held ? ' is-held' : '') + '">' +
        '<span class="verdict-word">' + words[res.verdict] + '</span>' +
        '<span class="verdict-detail">' +
        // With the box empty the number has to be stated: nothing else on
        // screen says which reading this verdict is about.
        (held ? 'recorded ' + TP.fmt(res.measured) + ' ' + esc(tp.unit || 'V') + pct
              : TP.fmt(res.deviation) + ' ' + esc(tp.unit || 'V') + ' from nominal' + pct) +
        '</span></div>';
      // Needle position: nominal at centre, limits at the band edges.
      var frac = 0.5 + (res.deviation / (res.tol || 1)) * 0.5;
      frac = Math.max(0, Math.min(1, frac));
      needle = '<span class="tolbar-needle" style="left:calc(' +
        (frac * 100).toFixed(1) + '% - 1px)"></span>';
    }
    html +=
      '<div class="tolbar' + (res ? (held ? ' is-held' : '') : ' is-idle') + '">' +
      needle + '</div>' +
      '<div class="tolbar-scale"><span>' + TP.fmt(range.lo) + '</span>' +
      '<span>' + TP.fmt(range.nominal) + '</span>' +
      '<span>' + TP.fmt(range.hi) + '</span></div>';
    return html;
  }

  function renderVerdictPreview() {
    var slot = document.getElementById('verdict-slot');
    var input = document.getElementById('measure-input');
    if (!slot || !input) return;
    var tp = BE.lookup(BE.state.selected);
    var states = TP.states(tp);
    var st = states[Math.min(stateIndex, states.length - 1)];
    slot.innerHTML = slotHTML(tp, st, input.value);
  }

  function readingsTable(session) {
    return '<table class="readings"><thead><tr>' +
      '<th>Point</th><th>Mode</th><th class="num">Measured</th>' +
      '<th class="num">Off nom.</th><th></th></tr></thead><tbody>' +
      session.readings.slice().reverse().map(function (r) {
        // A component reading carries its own unit, and a resistance shown
        // without one reads as volts next to the test points above it.
        // What was typed, not what rounds nicely: TP.fmt drops to whole units
        // above 100, so a rail entered as 564.8 would read back as 565 in the
        // list you check it against.
        // A pin sweep has no single measured value. Showing the pins inline
        // keeps the log one table -- the alternative was a row reading "—",
        // which hides the very thing that was recorded.
        if (r.target === 'pins') {
          var list = (r.pins || []).map(function (p) {
            return '<span class="pin-read"><b>' + p.pin + '</b>' + esc(TP.fmt(p.v)) + '</span>';
          }).join('');
          return '<tr data-ref="' + esc(r.ref) + '">' +
            '<td>' + esc(r.ref) + '</td>' +
            '<td style="color:var(--silk-faint)">' + esc(r.condition || 'pin sweep') + '</td>' +
            '<td class="num pin-reads" colspan="2">' + list + '</td>' +
            '<td><button class="note-del" data-reading="' + r.id + '">×</button></td></tr>';
        }
        var shown = r.target === 'component'
          ? Parts.format(r.base, r.quantity, (r.spec && r.spec.unit) || r.unit)
          : String(Math.round(r.measured * 1e4) / 1e4);
        var how = r.target === 'component'
          ? (Parts.quantity(r.quantity) || {}).label +
            (r.inCircuit ? ', in circuit' : ', out of circuit')
          : (r.stateLabel || '');
        return '<tr data-ref="' + esc(r.ref) + '">' +
          '<td>' + esc(r.ref) + '</td>' +
          '<td style="color:var(--silk-faint)">' + esc(how) + '</td>' +
          '<td class="num">' + esc(shown) + '</td>' +
          '<td class="num v-' + r.verdict + '">' +
          (r.pctOffNominal == null ? TP.fmt(r.deviation) : r.pctOffNominal.toFixed(1) + '%') +
          '</td>' +
          '<td><button class="note-del" data-reading="' + r.id + '">×</button></td></tr>';
      }).join('') + '</tbody></table>';
  }

  /**
   * Notes about the visit rather than about a part.
   *
   * The per-component notes cover "what is wrong with C13"; these cover what
   * state the instrument was in, what was tried and abandoned, and what the
   * next person should pick up -- which until now had nowhere to go.
   */
  function sessionNotesHTML(session) {
    var notes = (session.log || []).slice().reverse();
    var html = '';
    if (session.notes) {
      html += '<div class="note"><div class="note-meta">when the session was started</div>' +
        esc(session.notes) + '</div>';
    }
    html += notes.map(function (n) {
      return '<div class="note"><div class="note-meta">' +
        esc(n.at.slice(0, 16).replace('T', ' ')) +
        (n.author ? ' · ' + esc(n.author) : '') +
        '<button class="note-del" data-act="del-session-note" data-id="' + esc(n.id) +
        '" title="Delete note">✕</button></div>' + esc(n.text) + '</div>';
    }).join('');
    if (!notes.length && !session.notes) {
      html += '<div class="empty">Nothing recorded about this visit yet.</div>';
    }
    html += '<div class="field"><textarea id="session-note-input" rows="2" ' +
      'placeholder="What state is it in, what you tried, what to pick up next"></textarea></div>' +
      '<div class="btn-row"><button class="btn" data-act="add-session-note">Add note</button></div>';
    return html;
  }

  function repairsTable(repairs) {
    return '<table class="readings"><thead><tr>' +
      '<th>Ref</th><th>State</th><th>Detail</th><th></th></tr></thead><tbody>' +
      repairs.map(function (r) {
        var fitted = r.fitted || {};
        var detail = r.symptom || '';
        if (r.status === 'replaced' && fitted.desc) {
          detail += (detail ? ' — ' : '') + 'fitted ' + fitted.desc +
            (fitted.substitute ? ' (substitute)' : '');
        }
        return '<tr data-ref="' + esc(r.ref) + '">' +
          '<td>' + esc(r.ref) + '</td>' +
          '<td><span class="tag t-' + esc(r.status) + '">' + esc(r.status) + '</span></td>' +
          '<td style="color:var(--silk-faint)">' + esc(detail) +
            '<div class="micro">' + esc(r.at.slice(0, 10)) + '</div></td>' +
          '<td><button class="note-del" data-repair="' + esc(r.id) + '">×</button></td></tr>';
      }).join('') + '</tbody></table>';
  }

  function renderProcedurePanel() {
    var d = BE.state.assembly;
    var proc = Proc.current(d);
    if (!proc) {
      // Chapter 5's numbered procedures cover only some of the boards. Where a
      // board has none, its fault codes are the published troubleshooting, so
      // send the reader there rather than leaving them at a dead end.
      var codes = ((d && d.faultCodes) || []).length;
      el.panelBody.innerHTML = '<div class="empty">The service manual has no numbered ' +
        'troubleshooting section for ' + esc(d.id) + '.' +
        (codes ? ' Its published procedure is the ' + codes + ' diagnostic fault codes — ' +
          'see the <b>Fault codes</b> tab.' : '') + '</div>';
      return;
    }
    var intro = '<div class="source-note" style="padding:8px 12px">' + esc(proc.prereq) + '</div>';
    // Some sections number their setup paragraph as step 1 -- §5-23 does --
    // so the list opens at 2, and a list that opens at 2 with nothing said
    // reads as a step gone missing. Derived from the data, not a board list:
    // any procedure whose first numbered step is not 1 gets the line.
    var firstStep = proc.steps.length ? proc.steps[0].n : 1;
    if (firstStep > 1) {
      intro += '<div class="source-note" style="padding:0 12px 8px">' +
        (firstStep === 2 ? 'Step 1 is'
                         : 'Steps 1–' + (firstStep - 1) + ' are') +
        ' the setup above — the numbered list picks up at ' + firstStep + '.</div>';
    }
    var html = section(proc.title, proc.source, intro);

    (d.warnings || []).forEach(function (w) {
      html += '<div class="hazard-strip">▲ ' + esc(w) + '</div>';
    });

    html += '<div>' + proc.steps.map(function (step) {
      var done = Proc.isDone(d.id, step.n);
      var isActive = activeStep === step.n;
      var targets = Proc.targets(d, step);
      var suspects = Proc.suspects(d, step);
      var body = '';
      if (isActive) {
        body += '<div class="step-text">' + esc(step.text) + '</div>';
        if (targets.length) {
          body += '<div class="micro" style="padding:8px 0 4px">Measure</div>' +
            targets.map(function (t) { return measureRowHTML(t, step.n); }).join('') +
            '<div class="btn-row" style="padding:6px 0 0">' +
            '<button class="btn" data-act="record-step" data-step="' + step.n + '">' +
            'Record entered values</button>' +
            '<span class="micro" style="align-self:center">Fill in what you measured — ' +
            'partial is fine</span></div>';
        }
        if (suspects.length) {
          body += '<div class="field" style="padding:6px 0 0">' +
            '<span class="micro">If it fails, check</span>' +
            '<div class="chiprow">' + suspects.map(chipHTML).join('') + '</div></div>';
        }
        body += '<div class="btn-row" style="padding-left:0">' +
          '<button class="btn" data-act="step-done" data-step="' + step.n + '">' +
          (done ? 'Mark not done' : 'Mark done') + '</button></div>';
      }
      var status = stepStatus(step);
      var tone = status.entered
        ? (status.entered >= status.total ? (status.worst || 'pass') : 'partial')
        : '';
      // Only the procedure's heads carry tabindex: the fault-code and caveat
      // blocks reuse .step-head but fold nothing, so putting them in the tab
      // order would offer a press that does nothing.
      return '<div class="step' + (isActive ? ' is-active' : '') + (done ? ' is-done' : '') +
        (tone ? ' s-' + tone : '') + '" data-step="' + step.n + '">' +
        '<div class="step-head" tabindex="0"><span class="step-n">' + step.n + '</span>' +
        '<span class="step-title">' + esc(firstSentence(step.text)) + '</span>' +
        stepStatusHTML(status) +
        (done ? '<span class="pill ok">done</span>' : '') + '</div>' + body + '</div>';
    }).join('') + '</div>';

    html += '<div class="btn-row"><button class="btn" data-act="reset-procedure">Reset progress</button></div>';
    el.panelBody.innerHTML = html;
    bindList();
  }

  /**
   * Fault codes are where a diagnosis usually starts: the instrument reports
   * one, and the code says what to measure on which board. Each entry keeps
   * the manual's branch logic, because "in tolerance" and "out of tolerance"
   * send you to different assemblies.
   */
  /* ================= recap: the capacitor replacement round ================= */

  // Which family is on screen, and which parts are ticked for the order.
  var recapFamily = 'TA';
  var recapScope = 'board';    // board | all
  var recapLoss = 0;           // aluminium only: show parts measured this far down
  var recapOpen = null;        // 'A17/C13' -- the row whose work-up is expanded
  var recapConsolidate = false; // roll the order up to the fewest part numbers

  /**
   * Which parts are ticked for the order, as 'A17/C13' -> true.
   *
   * Kept in storage rather than in a variable, because the selection this
   * builds is the point of the whole mode and it is built across boards: you
   * walk seventeen datasets ticking parts, and losing that to a reload would
   * make the merged order list not worth starting. Scoped to the unit for the
   * same reason readings are -- two calibrators on a bench are two different
   * recaps, and half of one instrument's order landing in the other's is a
   * mistake you would only find with the parts in your hand.
   */
  var RECAP_KEY = 'fluke5700a.recappick.v1';
  var recapPicked = null;      // loaded on first use; see picks()
  var recapPickedUnit = null;

  // Lazily, and re-read when the active unit changes: this file runs before
  // Units.ensure() has settled on a unit, and switching units mid-session must
  // switch the order list with it rather than carry one instrument's ticks over.
  function picks() {
    var unit = Units.activeId();
    if (recapPicked === null || recapPickedUnit !== unit) {
      recapPickedUnit = unit;
      try {
        recapPicked = (JSON.parse(global.localStorage.getItem(RECAP_KEY)) || {})[unit] || {};
      } catch (err) {
        recapPicked = {};
      }
    }
    return recapPicked;
  }

  function savePicks() {
    try {
      var all = JSON.parse(global.localStorage.getItem(RECAP_KEY)) || {};
      all[recapPickedUnit] = recapPicked;
      global.localStorage.setItem(RECAP_KEY, JSON.stringify(all));
    } catch (err) { /* session-only is acceptable */ }
  }

  var FAMILIES = [
    { id: 'TA', label: 'Tantalum', types: ['TA'],
      blurb: 'Ranked by voltage margin — how close the rail runs to the part’s rating. ' +
             'A solid tantalum wants to sit under half its rating.' },
    { id: 'AL', label: 'Aluminium', types: ['AL'],
      blurb: 'Ranked smallest first. A small can holds little electrolyte, so it dries ' +
             'out and its ESR climbs long before a large one does.' }
  ];

  var SCOPES = [
    { id: 'board', label: 'This board' },
    { id: 'all',   label: 'All boards' }
  ];

  function recapFam() {
    return FAMILIES.find(function (f) { return f.id === recapFamily; }) || FAMILIES[0];
  }

  /**
   * Arrive on a family tab that has something under it.
   *
   * Tantalum leads the pair, but a board can carry only cans -- and then the
   * mode opened onto an empty Tantalum list with its twenty-seven aluminiums
   * one unmarked click away. Only the arrival is corrected, on entering the
   * mode or landing on a new board: a tab clicked after that is a question
   * about that family and the answer stands, empty or not.
   */
  function autoPickRecapFamily() {
    if (!global.Caps || !BE.state.assembly) return;
    var all = recapScope === 'all';
    function count(f) {
      return (all ? Caps.listAll({ types: f.types })
                  : Caps.list(BE.state.assembly, { types: f.types })).length;
    }
    if (count(recapFam())) return;
    var other = FAMILIES.filter(function (f) { return f.id !== recapFamily; })[0];
    if (other && count(other)) recapFamily = other.id;
  }

  /**
   * The capacitors on screen, in the order that puts the work first.
   *
   * Scope is what makes this mode worth using: an order placed one board at a
   * time is an order with the same part on it five times over, and the boards
   * are all in memory anyway, so there is no reason the audit has to stop at
   * the one on the bench.
   */
  function recapRows() {
    var fam = recapFam();
    var opts = { types: fam.types };
    var rows = recapScope === 'all' ? Caps.listAll(opts) : Caps.list(BE.state.assembly, opts);
    if (recapFamily === 'AL' && recapLoss) {
      rows = rows.filter(function (a) {
        var loss = capLoss(a.assembly, a.ref);
        return loss != null && loss <= -recapLoss;
      });
      rows.sort(function (a, b) {
        return capLoss(a.assembly, a.ref) - capLoss(b.assembly, b.ref);
      });
      return rows;
    }
    if (recapFamily === 'AL') {
      // Age, not margin, is what kills these, and capacitance is the proxy the
      // parts list actually gives us: the smaller the can, the less electrolyte
      // there is to lose. Ties fall back to the designator so the order is stable.
      rows.sort(function (a, b) {
        var av = capValue(a.item), bv = capValue(b.item);
        if (av == null && bv == null) return 0;
        if (av == null) return 1;
        if (bv == null) return -1;
        if (av !== bv) return av - bv;
        if (a.assembly !== b.assembly) return Caps.sortAsm(a.assembly, b.assembly);
        return a.ref < b.ref ? -1 : 1;
      });
    }
    return rows;
  }

  /**
   * The worst capacitance this part has measured, as a loss against nominal.
   *
   * Electrolytics fail by drying out, so the number that finds them is not the
   * reading but the shortfall. Returns null when it has never been measured --
   * which is different from having measured fine, and is why an unmeasured part
   * is not swept up by a loss filter.
   */
  function capLoss(asm, ref) {
    // history() hands back {session, reading} pairs, not bare readings.
    var worst = null;
    (Log.history(asm, ref) || []).forEach(function (h) {
      var r = h.reading;
      if (!r || r.quantity !== 'capacitance' || r.pctOffNominal == null) return;
      if (worst == null || r.pctOffNominal < worst) worst = r.pctOffNominal;
    });
    return worst;
  }

  function capValue(item) {
    var spec = Parts.spec(item);
    return spec && spec.quantity === 'capacitance' ? spec.base : null;
  }

  function recapKey(a) { return a.assembly + '/' + a.ref; }

  /** Where this part has got to in the swap, read off the log rather than kept twice. */
  function recapProgress(asm, ref) {
    var repairs = Log.repairs(asm).filter(function (r) { return r.ref === ref; });
    var latest = repairs.length ? repairs[repairs.length - 1] : null;
    var measured = (Log.history(asm, ref) || []).map(function (h) { return h.reading; })
      .filter(function (r) {
        return r && (r.quantity === 'capacitance' || r.quantity === 'esr');
      });
    return {
      repair: latest,
      removed: !!latest && /removed|replaced/.test(latest.status || ''),
      fitted: !!(latest && latest.fitted && (latest.fitted.mfrPart || latest.fitted.desc)),
      measured: measured
    };
  }

  function renderRecapPanel() {
    var d = BE.state.assembly;
    var fam = recapFam();
    var all = recapScope === 'all';
    var rows = recapRows();
    var html = '';

    html += '<div class="segmented small recap-family" role="group" aria-label="Capacitor family">' +
      FAMILIES.map(function (f) {
        var n = (all ? Caps.listAll({ types: f.types })
                     : Caps.list(d, { types: f.types })).length;
        return '<button data-recap-family="' + f.id + '"' +
          (f.id === recapFamily ? ' class="is-active"' : '') + '>' +
          esc(f.label) + ' <span class="kindcount">' + n + '</span></button>';
      }).join('') + '</div>';

    html += '<div class="segmented small recap-scope" role="group" aria-label="Scope">' +
      SCOPES.map(function (sc) {
        return '<button data-recap-scope="' + sc.id + '"' +
          (sc.id === recapScope ? ' class="is-active"' : '') + '>' +
          esc(sc.label) + '</button>';
      }).join('') + '</div>';

    html += '<div class="recap-blurb micro">' + esc(fam.blurb) +
      (all ? ' Every board at once, so one order covers the instrument.' : '') + '</div>';

    if (recapFamily === 'TA') html += recapSummaryHTML(fam);
    if (recapFamily === 'AL') html += recapLossHTML(fam);

    var picks_ = picks();
    var picked = rows.filter(function (a) { return picks_[recapKey(a)]; });
    // What is ticked elsewhere still gets ordered, so it has to be visible from
    // here -- otherwise the count on screen contradicts the file that comes out.
    var elsewhere = Object.keys(picks_).length - picked.length;

    html += recapBulkHTML(rows, fam);

    html += '<div class="recap-bar">' +
      '<button class="btn" data-act="recap-all">' +
        (picked.length === rows.length && rows.length ? 'Clear all' : 'Select all') + '</button>' +
      '<span class="micro">' + picked.length + ' of ' + rows.length + ' picked' +
        (elsewhere > 0 ? ' <span class="dim">(+' + elsewhere + ' elsewhere)</span>' : '') +
        '</span>' +
      '<span class="spacer"></span>' +
      (elsewhere > 0 ? '<button class="btn" data-act="recap-clear-all">Clear every board</button>' : '') +
      '<button class="btn' + (recapConsolidate ? ' is-active' : '') +
        '" data-act="recap-consolidate" title="One rating per value — the highest any ' +
        'position needs. Fewer part numbers, physically larger cans where less would do."' +
        '>' + (recapConsolidate ? 'Fewest part numbers' : 'Per position') + '</button>' +
      '<button class="btn" data-act="recap-bom"' +
        (picked.length + Math.max(elsewhere, 0) ? '' : ' disabled') +
        '>Replacement BOM</button>' +
      '</div>';

    html += section('Capacitors',
      rows.length + (all ? ' across ' + boardsIn(rows) + ' boards' : ' on ' + esc(d.id)),
      rows.length ? rows.map(recapRowHTML).join('')
                  : '<div class="empty">No ' + esc(fam.label.toLowerCase()) +
                    ' capacitors on ' + (all ? 'any board.' : 'this board.') + '</div>');

    el.panelBody.innerHTML = html;
    bindList();
  }

  function boardsIn(rows) {
    var seen = {};
    rows.forEach(function (a) { seen[a.assembly] = true; });
    return Object.keys(seen).length;
  }

  function recapSummaryHTML(fam) {
    var counts = Caps.summary(recapScope === 'all' ? 'all' : BE.state.assembly,
                              { types: fam.types });
    var order = ['error', 'critical', 'high', 'unknown', 'marginal', 'ok'];
    return '<div class="recap-summary">' + order.filter(function (k) { return counts[k]; })
      .map(function (k) {
        return '<span class="riskchip r-' + k + '">' + counts[k] + ' ' +
          esc(k === 'ok' ? 'ok' : k) + '</span>';
      }).join('') + '</div>';
  }

  /**
   * Tick a whole band at once.
   *
   * Going through a hundred and twenty parts with a mouse to find the twenty
   * worth ordering is the work this mode exists to remove, and the bands are
   * already the answer: everything at or past 65% is the list, and the untraced
   * ones are the list of things to go and look up before ordering anything.
   * Offered on the rows currently on screen, so it obeys the scope switch.
   */
  var RECAP_BULK = [
    { id: 'critical', label: '≥ 80%', test: function (a) { return a.ratio != null && a.ratio >= 0.80; } },
    { id: 'high',     label: '≥ 65%', test: function (a) { return a.ratio != null && a.ratio >= 0.65; } },
    { id: 'marginal', label: '≥ 50%', test: function (a) { return a.ratio != null && a.ratio >= 0.50; } },
    { id: 'unknown',  label: 'untraced', test: function (a) { return a.ratio == null; } }
  ];

  function recapBulkHTML(rows, fam) {
    if (fam.id !== 'TA') return '';
    var chips = RECAP_BULK.map(function (b) {
      var n = rows.filter(b.test).length;
      return !n ? '' : '<button class="chip" data-recap-bulk="' + b.id + '">' +
        esc(b.label) + '<span class="kindcount">' + n + '</span></button>';
    }).join('');
    if (!chips) return '';
    return '<div class="recap-bulk"><span class="micro">Tick</span>' + chips + '</div>';
  }

  /**
   * Filter the cans by how much capacitance they have lost.
   *
   * Only offered for aluminium: a tantalum does not dry out, so a shortfall on
   * one means something else entirely and this would be the wrong question.
   * The thresholds are the ones that matter on a bench -- 20% is the edge of a
   * typical part's own tolerance, so anything past it is real loss rather than
   * spread.
   */
  function recapLossHTML(fam) {
    var all = recapScope === 'all' ? Caps.listAll({ types: fam.types })
                                   : Caps.list(BE.state.assembly, { types: fam.types });
    var measured = all.filter(function (a) {
      return capLoss(a.assembly, a.ref) != null;
    }).length;
    var steps = [0, 10, 20, 50];
    return '<div class="recap-loss">' +
      '<span class="micro">Capacitance lost</span>' +
      steps.map(function (n) {
        var hits = n === 0 ? all.length : all.filter(function (a) {
          var l = capLoss(a.assembly, a.ref);
          return l != null && l <= -n;
        }).length;
        return '<button class="chip' + (recapLoss === n ? ' is-active' : '') +
          '" data-recap-loss="' + n + '">' +
          (n === 0 ? 'All' : '≥ ' + n + '%') +
          '<span class="kindcount">' + hits + '</span></button>';
      }).join('') +
      '<span class="micro dim">' + measured + ' of ' + all.length + ' measured</span>' +
      '</div>';
  }

  function recapRowHTML(a) {
    var key = recapKey(a);
    var open = recapOpen === key;
    var prog = recapProgress(a.assembly, a.ref);
    var spec = Parts.spec(a.item);
    var value = spec ? Parts.format(spec.base, 'capacitance', spec.unit) : '—';

    // The state chips get a line of their own.
    //
    // They used to be grid children alongside the data, which meant a row had
    // six children before it was touched and nine after it had been measured,
    // pulled and refitted -- against a template of eight columns. Grid fills
    // the declared tracks in order, so every row with a different amount of
    // history put its designator in a different column, and the ninth chip
    // spilled onto a line by itself. Giving them their own full-width line
    // instead leaves the data columns identical on every row whatever has
    // happened to the part, and lets the chips wrap among themselves.
    var chips = '';
    var loss = capLoss(a.assembly, a.ref);
    if (loss != null) {
      chips += '<span class="riskchip ' +
        (loss <= -20 ? 'r-critical' : loss <= -10 ? 'r-high' : 'r-ok') + '">' +
        (loss > 0 ? '+' : '') + loss.toFixed(0) + '% measured</span>';
    }
    if (prog.removed) chips += '<span class="pill ok">out</span>';
    if (prog.fitted) chips += '<span class="pill ok">fitted</span>';

    var head = '<div class="recap-head' + (recapScope === 'all' ? ' has-asm' : '') +
      '" data-recap-open="' + esc(key) + '" tabindex="0">' +
      '<input type="checkbox" class="recap-pick" data-recap-pick="' + esc(key) + '"' +
        (picks()[key] ? ' checked' : '') + '>' +
      (recapScope === 'all'
        ? '<span class="recap-asm">' + esc(a.assembly) + '</span>' : '') +
      '<span class="hit-ref">' + esc(a.ref) + '</span>' +
      '<span class="recap-value">' + esc(value) + '</span>' +
      '<span class="recap-rated">' + (a.ratedV != null ? esc(a.ratedV) + ' V' : '—') + '</span>' +
      // Voltage first, net second. This column is the one that gives when the
      // panel is narrow, and the applied voltage is the number the whole row is
      // about -- losing the tail of a net name costs nothing, losing the volts
      // leaves a row that says only that some rail was traced.
      '<span class="recap-applied">' + (a.isTantalum
        ? (a.appliedV != null
            ? esc(a.appliedV) + ' V' + (a.net ? ' \u00b7 ' + esc(a.net) : '')
            : 'rail not traced')
        : esc(a.net || '')) + '</span>' +
      // Emitted even for aluminium, where there is no margin to score, so the
      // two families keep the same columns and the list does not step sideways
      // when you switch between them.
      (a.isTantalum
        ? '<span class="riskchip r-' + a.risk + '">' +
            (a.ratio != null ? Math.round(a.ratio * 100) + '%' : '?') + '</span>'
        : '<span class="recap-norisk"></span>') +
      (chips ? '<span class="recap-state">' + chips + '</span>' : '') +
      '</div>';


    if (!open) return '<div class="recap-row' + (prog.fitted ? ' is-done' : '') + '">' + head + '</div>';

    // The work-up records against the active session, which belongs to one
    // board. Opening a row switches to its board first, so this normally cannot
    // happen -- but changing the board from the dropdown with a row open would
    // otherwise leave measurement boxes that would file against the wrong
    // assembly, which is the one mistake in a service record you cannot spot
    // later.
    if (BE.state.assembly && a.assembly !== BE.state.assembly.id) {
      return '<div class="recap-row is-open">' + head +
        '<div class="recap-body"><div class="recap-advice micro">' +
        esc(a.ref) + ' is on ' + esc(a.assembly) + '. Open that board to measure, ' +
        'remove or fit it — readings file against the board the session is on.' +
        '</div><div class="btn-row"><button class="btn" data-recap-goto="' +
        esc(a.assembly) + '">Go to ' + esc(a.assembly) + '</button></div></div></div>';
    }

    var r = prog.repair || {};
    var f = r.fitted || {};
    var body = '<div class="recap-body">';

    if (a.isTantalum && a.recommend) {
      body += '<div class="recap-advice micro' + (a.risk === 'error' ? ' is-error' : '') + '">' +
        (a.risk === 'error'
          ? 'This reads as ' + Math.round(a.ratio * 100) + '% of its rating, which cannot be ' +
            'the original design — a tantalum above its rating fails on the first power-up, ' +
            'so the instrument would never have worked. Treat it as wrong data: check the ' +
            'rail this actually sits on, and correct it in Author Mode.'
          : (a.appliedV != null
          ? 'On ' + esc(a.net || 'this rail') + ' at ' + esc(a.appliedV) + ' V, fit at least ' +
            esc(a.recommend.minimumV) + ' V — ' +
            (a.recommend.standardV ? 'the standard size is ' + esc(a.recommend.standardV) + ' V'
                                   : 'above any standard single part') +
            (a.recommend.seriesSuggested ? ', or two in series' : '') + '.'
          : 'Rail not traced, so no recommendation. Trace it or set the applied ' +
            'voltage in Author Mode before ordering.')) +
        (a.railClass ? ' <b>Rail class ' + esc(a.railClass) + '</b>.' : '') +
        (a.note ? '<br>' + esc(a.note) : '') + '</div>';
    }

    // 1. what came out
    // In circuit first: reading a can without unsoldering it is how a bad
    // aluminium is found in the first place, and the parallel paths around it
    // are why that reading has to be marked as what it is rather than filed
    // beside an out-of-circuit one as though they were the same measurement.
    body += '<div class="micro recap-step">Measurements</div>';
    body += '<div class="measure-grid recap-grid">' +
      '<input id="rc-cap" type="text" inputmode="decimal" placeholder="capacitance µF">' +
      '<input id="rc-esr" type="text" inputmode="decimal" placeholder="ESR Ω">' +
      '<button class="btn" data-act="recap-measure" data-ref="' + esc(a.ref) + '">Record</button>' +
      '</div>';
    body += '<label class="inline-check"><input type="checkbox" id="rc-incircuit"' +
      (prog.removed ? '' : ' checked') + '> measured in circuit</label>';
    var lim = Caps.esrLimit(a.item);
    if (lim) {
      var fig = lim.maxESR.toFixed(lim.maxESR < 1 ? 3 : 1);
      // The dissipation factor is where this number comes from, not something
      // to go and measure: nothing here asks for one, and a meter that reads
      // capacitance and ESR is all the round needs. It stays in the tooltip so
      // the figure can be traced back to the datasheet.
      var basis = ' title="' + esc('Derived from ' + lim.basis + ': ESR = DF / (2·π·120·C)') + '"';
      body += '<div class="recap-measured micro"' + basis + '>' + (a.type === 'AL'
        // For a can, this is a threshold: past it the electrolyte has gone.
        ? 'Should be well under <b>' + fig + ' Ω</b> — a gross upper limit for this ' +
          'capacitance and rating. Rising ESR is how these fail: the electrolyte ' +
          'evaporates and ESR climbs before the capacitance does. A good part of any ' +
          'series sits far below this; past it, the part is finished.'
        // For a tantalum it is a reference figure, not a threshold.
        : 'Expected ESR about <b>' + fig + ' Ω</b>. A tantalum’s ESR does not drift ' +
          'with age, so this is not a health check — record it to compare the ' +
          'replacement against the original.') +
        '</div>';
    }
    if (prog.measured.length) {
      body += '<div class="recap-measured micro">' + prog.measured.slice(-4).map(function (m) {
        return esc((Parts.quantity(m.quantity) || {}).label || m.quantity) + ' ' +
          esc(Parts.format(m.base, m.quantity, m.unit)) +
          ' <span class="dim">' + (m.inCircuit ? 'in circuit' : 'out') + '</span>' +
          // How far off the parts list it is, which for a dried-out aluminium
          // is the whole story -- the absolute number means little until you
          // know it should have been 22 uF.
          (m.pctOffNominal != null
            ? ' <span class="' + (m.verdict && m.verdict !== 'unscored' ? 'v-' + m.verdict : 'dim') +
              '">' + (m.pctOffNominal > 0 ? '+' : '') + esc(m.pctOffNominal.toFixed(1)) + '%</span>'
            : '') +
          // The BOM states no ESR, so the log cannot score one. The datasheet
          // limit can, and that is the judgement worth showing here.
          (function () {
            if (m.quantity !== 'esr') return '';
            var j = Caps.judgeESR(a.item, m.base);
            if (!j) return '';
            // Only an aluminium gets a verdict; a tantalum gets the number and
            // a note that it is not a diagnosis.
            return j.diagnostic
              ? ' <span class="v-' + j.verdict + '">' + esc(j.verdict) +
                ' (' + j.ratio.toFixed(1) + '× limit)</span>'
              : ' <span class="dim">' + j.ratio.toFixed(1) + '× datasheet</span>';
          }()) +
          (m.verdict && m.verdict !== 'unscored'
            ? ' <span class="v-' + m.verdict + '">' + esc(m.verdict) + '</span>' : '');
      }).join(' · ') + '</div>';
    }
    body += '<div class="btn-row">' +
      '<button class="btn' + (prog.removed ? '' : ' primary') + '" data-act="recap-removed" data-ref="' +
        esc(a.ref) + '"' + (prog.removed ? ' disabled' : '') + '>' +
        (prog.removed ? 'Marked out of circuit' : 'Mark removed') + '</button>' +
      '</div>';

    // 2. what went in
    body += '<div class="micro recap-step">Replacement fitted</div>';
    body += '<div class="recap-fitted">' +
      '<input id="rf-part" type="text" placeholder="part number" list="fitted-parts" ' +
        'autocomplete="off" value="' + esc(f.mfrPart || '') + '">' +
      '<input id="rf-value" type="text" inputmode="decimal" placeholder="value µF" value="' +
        esc(f.valueUF || '') + '">' +
      '<input id="rf-rated" type="text" inputmode="decimal" placeholder="rating V" value="' +
        esc(f.ratedV || '') + '">' +
      '<input id="rf-meas" type="text" inputmode="decimal" placeholder="measured µF" value="' +
        esc(f.measuredUF || '') + '">' +
      '<input id="rf-esr" type="text" inputmode="decimal" placeholder="ESR Ω" value="' +
        esc(f.esr || '') + '">' +
      '</div>' +
      fittedDatalistHTML('fitted-parts') +
      '<div class="fitted-hint" id="rf-part-hint"></div>';
    if (f.esr) {
      var jf = Caps.judgeESR(a.item, parseFloat(f.esr));
      if (jf) {
        // What the part that came out measured, so the two can be set side by
        // side -- the comparison that actually matters for a tantalum.
        var wasESR = null;
        prog.measured.forEach(function (m) {
          if (m.quantity === 'esr' && !m.inCircuit) wasESR = m.base;
        });
        var cmp = jf.diagnostic ? null : Caps.compareESR(wasESR, parseFloat(f.esr));
        body += '<div class="recap-measured micro">Fitted part ESR ' + esc(f.esr) + ' Ω — ' +
          (jf.diagnostic
            ? '<span class="v-' + jf.verdict + '">' + esc(jf.label) + '</span>'
            : esc(jf.label)) +
          (cmp ? '. Original measured ' + wasESR.toFixed(2) + ' Ω, so the new part is ' +
                 esc(cmp.label) + '.' : '') +
          '</div>';
      }
    }
    if (f.deltaPct != null) {
      body += '<div class="recap-measured micro">Fitted part measures ' +
        (f.deltaPct > 0 ? '+' : '') + esc(f.deltaPct) + '% of its nominal' +
        (Math.abs(f.deltaPct) > 20 ? ' — outside a typical ±20% part' : '') + '</div>';
    }
    body += '<div class="btn-row">' +
      '<button class="btn primary" data-act="recap-fitted" data-ref="' + esc(a.ref) + '">' +
        (prog.fitted ? 'Update fitted part' : 'Record fitted part') + '</button>' +
      '<button class="btn" data-act="show-board" data-ref="' + esc(a.ref) + '">Show on board</button>' +
      '</div>';

    // The same notes as everywhere else, not a second set: a note written here
    // shows on the part's card in Board view and prints in the service report.
    body += notesHTML(BE.state.assembly.id, a.ref);

    body += '</div>';
    return '<div class="recap-row is-open' + (prog.fitted ? ' is-done' : '') + '">' + head + body + '</div>';
  }

  /**
   * What the part measured on the way out.
   *
   * Capacitance and ESR go into the log as ordinary component readings, so they
   * are scored against the parts list, appear in the part's own history and
   * turn up in the service report -- rather than living in a second place that
   * the report would have to learn about.
   */
  function recapMeasure(ref) {
    var d = BE.state.assembly;
    var item = BE.lookup(ref);
    if (!item) return;
    var rawCap = (document.getElementById('rc-cap') || {}).value;
    var rawEsr = (document.getElementById('rc-esr') || {}).value;
    var cap = readNumber(rawCap);
    var esr = readNumber(rawEsr);
    if (isNaN(cap) && isNaN(esr)) {
      var offender = String(rawCap || '').trim() ? rawCap : rawEsr;
      toast(numberComplaint(offender, 'Enter a capacitance or an ESR first')); return;
    }
    // The checkbox is read before the log is touched: starting a session
    // re-renders the row, and the rebuilt box comes back checked whenever the
    // part is not marked removed -- so a box unticked for a lifted leg would
    // read as ticked again by the time it was looked at.
    var box = document.getElementById('rc-incircuit');
    var inCircuit = !box || box.checked;
    if (!sessionHere()) Log.start({ assembly: d.id });
    // An in-circuit capacitance is read through whatever else is across the
    // part, so it is worth little on its own and a lot as a first pass. Saying
    // which it was is the difference between a screening number and a verdict.
    var where = inCircuit ? 'In circuit' : 'Removed part';
    var n = 0;
    if (!isNaN(cap)) {
      Log.recordComponent(item, { quantity: 'capacitance', value: cap, unit: 'µF',
                                  inCircuit: inCircuit, note: where });
      n++;
    }
    if (!isNaN(esr)) {
      var elim = Caps.esrLimit(item);
      Log.recordComponent(item, { quantity: 'esr', value: esr, unit: 'Ω',
                                  inCircuit: inCircuit, note: where,
                                  esrLimit: elim ? elim.maxESR : null });
      n++;
    }
    toast(ref + ': ' + n + ' reading(s) recorded, ' +
          (inCircuit ? 'in circuit' : 'out of circuit'));
    refresh();
  }

  function recapMarkRemoved(ref) {
    var d = BE.state.assembly;
    var item = BE.lookup(ref);
    if (!item) return;
    if (!sessionHere()) Log.start({ assembly: d.id });
    Log.addRepair(item, { status: 'removed',
                          symptom: 'Removed during capacitor replacement' });
    toast(ref + ' marked out of circuit');
    refresh();
  }

  /**
   * Every replacement part this instrument has had fitted, newest use first.
   *
   * Across all of its assemblies on purpose. The same 10 uF 25 V tantalum goes
   * into half the boards in a 5700A, and a manufacturer part number long
   * enough to be worth remembering is exactly the one nobody wants to retype
   * for each of them. Log.repairs with no assembly is already unit-scoped and
   * newest-first, so the first sighting of a part number is its latest use.
   */
  function fittedParts() {
    var seen = {};
    var out = [];
    Log.repairs(null).forEach(function (r) {
      var f = r.fitted;
      if (!f) return;
      var part = String(f.mfrPart || '').trim();
      if (!part) return;
      var key = part.toUpperCase();
      if (seen[key]) { seen[key].count++; return; }
      seen[key] = { part: part, count: 1, at: r.at, assembly: r.assembly, ref: r.ref,
                    valueUF: f.valueUF || '', ratedV: f.ratedV || '',
                    desc: f.desc || '', fluke: f.fluke || '' };
      out.push(seen[key]);
    });
    return out;
  }

  function fittedMatch(raw) {
    var want = String(raw == null ? '' : raw).trim().toUpperCase();
    if (!want) return null;
    var hit = null;
    fittedParts().forEach(function (p) {
      if (!hit && p.part.toUpperCase() === want) hit = p;
    });
    return hit;
  }

  /**
   * The remembered part numbers, as a native datalist.
   *
   * A datalist rather than a dock of our own: the browser does the matching
   * and the keyboard handling, it works with the page opened off the
   * filesystem, and where it is not supported the field is still an ordinary
   * text box rather than a broken menu.
   */
  function fittedDatalistHTML(id) {
    var parts = fittedParts();
    if (!parts.length) return '';
    return '<datalist id="' + esc(id) + '">' + parts.map(function (p) {
      var bits = [];
      if (p.valueUF) bits.push(p.valueUF + ' \u00b5F');
      if (p.ratedV) bits.push(p.ratedV + ' V');
      bits.push(p.count > 1 ? p.count + '\u00d7, last ' + p.assembly + ' ' + p.ref
                            : p.assembly + ' ' + p.ref);
      return '<option value="' + esc(p.part) + '">' + esc(bits.join(' \u00b7 ')) +
        '</option>';
    }).join('') + '</datalist>';
  }

  /**
   * Picking a remembered part number fills in what that part was last time.
   *
   * Only fields still empty are written to. Someone who has typed a value has
   * said something about the part in their hand, and a hint from a previous
   * visit must not overwrite it -- what is in these boxes is what the service
   * report prints. The line underneath says where the numbers came from, so a
   * field filling itself is explained rather than merely surprising.
   */
  function bindFittedHint(input, fields) {
    if (!input) return;
    var slot = document.getElementById(input.id + '-hint');
    function apply() {
      var hit = fittedMatch(input.value);
      if (!hit) { if (slot) slot.textContent = ''; return; }
      var filled = [];
      Object.keys(fields).forEach(function (id) {
        var box = document.getElementById(id);
        if (!box || !hit[fields[id]]) return;
        var untouched = !box.value.trim() ||
          (box.dataset.prefill != null && box.value === box.dataset.prefill);
        if (!untouched) return;
        box.value = hit[fields[id]];
        filled.push(id);
      });
      if (!slot) return;
      slot.textContent = 'Last fitted ' + hit.assembly + ' ' + hit.ref +
        (hit.valueUF ? ' \u00b7 ' + hit.valueUF + ' \u00b5F' : '') +
        (hit.ratedV ? ' ' + hit.ratedV + ' V' : '') +
        (hit.count > 1 ? ' \u00b7 used ' + hit.count + '\u00d7' : '') +
        (filled.length ? ' \u2014 filled in' : '');
    }
    input.addEventListener('input', apply);
    input.addEventListener('change', apply);
  }

  /**
   * What went in. Recorded as the repair's fitted part, which is where the
   * report already looks, with the extra fields a capacitor swap wants.
   */
  function recapSaveFitted(ref) {
    var d = BE.state.assembly;
    var item = BE.lookup(ref);
    if (!item) return;
    function v(id) {
      var e = document.getElementById(id);
      return e && e.value.trim() ? e.value.trim() : '';
    }
    // The replacement is worth checking too: a new part measured against what
    // it says on the reel catches a mislabelled or wrong-value bag before it
    // goes into the board rather than after.
    var nominal = parseFloat(v('rf-value'));
    var measured = parseFloat(v('rf-meas'));
    var deltaPct = (!isNaN(nominal) && !isNaN(measured) && nominal)
      ? ((measured - nominal) / nominal) * 100 : null;
    var fitted = {
      mfrPart: v('rf-part'), valueUF: v('rf-value'), ratedV: v('rf-rated'),
      measuredUF: v('rf-meas'), esr: v('rf-esr'),
      deltaPct: deltaPct == null ? null : Math.round(deltaPct * 10) / 10,
      desc: (v('rf-value') ? v('rf-value') + 'UF' : '') +
            (v('rf-rated') ? ', ' + v('rf-rated') + 'V' : ''),
      fluke: '', substitute: true
    };
    if (!fitted.mfrPart && !fitted.valueUF && !fitted.ratedV) {
      toast('Enter at least a part number or a value'); return;
    }
    if (!sessionHere()) Log.start({ assembly: d.id });
    // repairs() is newest first, so the row this refit closes is at the front
    // -- and by preference the newest 'removed' row, the pull the part is
    // coming back from. Patching the oldest row instead turned a suspect
    // entry into 'replaced' while a later 'removed' one went on saying the
    // part was out of the board.
    var mine = Log.repairs(d.id).filter(function (r) { return r.ref === ref; });
    var latest = mine.find(function (r) { return r.status === 'removed'; }) ||
      mine[0] || null;
    if (latest) Log.updateRepair(latest.id, { status: 'replaced', fitted: fitted });
    else Log.addRepair(item, { status: 'replaced', fitted: fitted,
                               symptom: 'Replaced during capacitor replacement' });
    toast(ref + ': replacement recorded' +
          (deltaPct == null ? ''
           : ', measured ' + (deltaPct > 0 ? '+' : '') + deltaPct.toFixed(1) + '% of nominal'));
    refresh();
  }

  /** The order list, as text you can paste into a distributor's basket. */
  /**
   * Everything ticked, anywhere in the instrument, as one order.
   *
   * Deliberately not the rows on screen. The selection is built by walking
   * seventeen boards, and a BOM that quietly exported only the board you
   * happened to be looking at is how the mode failed to be useful in the first
   * place -- you ended up with a file per board and had to merge them by hand,
   * which is exactly the job a machine should do.
   */
  function recapPickedRows() {
    var picked = picks();
    return Caps.listAll().filter(function (a) { return picked[recapKey(a)]; });
  }

  /**
   * The rating to fit at a position, and where that number comes from.
   *
   * The two families are answered by different questions and must not share an
   * answer. A tantalum is replaced to get margin, so the rating comes from the
   * derating table applied to the rail it sits on -- fitting like-for-like puts
   * back the part that was going to fail. An aluminium is replaced because it
   * has dried out, not because it was under-rated, so like-for-like is right and
   * the original rating is the number. Where the rail was never traced there is
   * no honest recommendation, and saying so beats printing the original rating
   * as though it had been checked.
   */
  function fitRating(a) {
    if (a.type === 'TA') {
      if (!a.recommend || a.recommend.standardV == null) return { v: null, why: 'untraced' };
      return { v: a.recommend.standardV, why: 'derated', min: a.recommend.minimumV,
               series: a.recommend.seriesSuggested };
    }
    return { v: a.ratedV, why: 'original' };
  }

  function capValueOf(a) {
    var spec = Parts.spec(a.item);
    return spec && spec.quantity === 'capacitance' ? spec.base : null;
  }

  function capValueText(a) {
    var spec = Parts.spec(a.item);
    return spec ? Parts.format(spec.base, 'capacitance', spec.unit) : '';
  }

  /**
   * Roll positions up into order lines.
   *
   * Grouped on what you actually buy: family, value, and the rating to fit. The
   * consolidated form drops the rating out of the key and takes the highest one
   * any position in that value needs, which is the trade worth offering rather
   * than deciding -- one part number instead of seven is a much shorter order,
   * but the part that satisfies the worst rail is a physically bigger can than
   * the others needed, and some of these positions are tight. So both forms are
   * available and the file says which one it is.
   */
  function recapOrderLines(rows, consolidate) {
    var groups = {};
    rows.forEach(function (a) {
      var fit = fitRating(a);
      var value = capValueOf(a);
      var key = [a.type, value == null ? '?' : value,
                 consolidate ? '' : (fit.v == null ? 'untraced' : fit.v)].join('|');
      var g = groups[key];
      if (!g) {
        g = groups[key] = { type: a.type, value: value, valueText: capValueText(a),
                            fitV: null, minV: null, why: fit.why, series: false,
                            untraced: 0, needs: [], refs: [], boards: {} };
      }
      if (fit.v == null) g.untraced++;
      else if (g.fitV == null || fit.v > g.fitV) {
        // The group takes the worst rail in it. Which positions that leaves
        // over-specified is counted once at the end rather than as we go --
        // incrementing here double-counts a position each time a later, higher
        // rail raises the bar again.
        g.fitV = fit.v;
        g.minV = fit.min != null ? fit.min : g.minV;
        g.why = fit.why;
      }
      g.series = g.series || !!fit.series;
      g.needs.push(fit.v);
      g.refs.push(a);
      g.boards[a.assembly] = (g.boards[a.assembly] || 0) + 1;
    });
    return Object.keys(groups).map(function (k) {
      var g = groups[k];
      g.oversized = g.needs.filter(function (v) {
        return v != null && g.fitV != null && v < g.fitV;
      }).length;
      if (g.fitV == null) g.why = 'untraced';
      return g;
    }).sort(function (x, y) {
      if (x.type !== y.type) return x.type < y.type ? -1 : 1;
      if (x.refs.length !== y.refs.length) return y.refs.length - x.refs.length;
      return (x.value || 0) - (y.value || 0);
    });
  }

  function boardsText(boards) {
    return Object.keys(boards).sort(Caps.sortAsm).map(function (b) {
      return boards[b] > 1 ? b + '×' + boards[b] : b;
    }).join(' ');
  }

  /** The order list, as text you can paste into a distributor's basket. */
  function recapBOM() {
    var rows = recapPickedRows();
    if (!rows.length) { toast('Tick the capacitors you plan to replace first'); return; }
    var lines_ = recapOrderLines(rows, recapConsolidate);
    var boards = {};
    rows.forEach(function (a) { boards[a.assembly] = true; });
    var nBoards = Object.keys(boards).length;
    var alt = recapOrderLines(rows, !recapConsolidate).length;

    var out = ['# Replacement capacitors — ' + (Units.label ? Units.label(Units.ensure()) : ''),
               '# ' + rows.length + ' positions on ' + nBoards + ' board' +
                 (nBoards === 1 ? '' : 's') + ', ' + lines_.length + ' order lines',
               '# Rollup: ' + (recapConsolidate
                 ? 'fewest part numbers — one rating per value, the highest any position needs'
                 : 'per position — each rail gets exactly the rating it needs') +
                 ' (' + alt + ' lines the other way)',
               '# Tantalum ratings: Vishay MnO2 derating table, below 85 C. Aluminium: ' +
                 'replaced like for like, so the original rating stands.',
               '',
               '## ORDER'];
    out.push(['Qty', 'Type', 'Value', 'Fit', 'Basis', 'Used on'].join('\t'));
    lines_.forEach(function (g) {
      out.push([
        g.refs.length,
        Caps.typeLabel(g.type),
        g.valueText,
        g.fitV == null ? '—' : g.fitV + ' V' + (g.series ? ' (or series pair)' : ''),
        (g.why === 'untraced' ? 'rail not traced — check before ordering'
          : g.why === 'original' ? 'original rating'
          : 'derated from ' + (g.minV != null ? g.minV + ' V minimum' : 'the rail')) +
          (g.oversized ? ', ' + g.oversized + ' position(s) need less' : '') +
          (g.untraced && g.fitV != null
            ? ', ' + g.untraced + ' untraced position(s) assumed to fit' : ''),
        boardsText(g.boards)
      ].join('\t'));
    });

    out.push('', '## POSITIONS');
    out.push(['Assembly', 'Ref', 'Value', 'Fitted rating', 'Rail', 'Applied V', 'Use %',
              'Fit at least', 'Standard', 'Note'].join('\t'));
    rows.slice().sort(function (x, y) {
      if (x.assembly !== y.assembly) return Caps.sortAsm(x.assembly, y.assembly);
      return x.rank - y.rank;
    }).forEach(function (a) {
      out.push([
        a.assembly,
        a.ref,
        capValueText(a),
        a.ratedV != null ? a.ratedV + ' V' : '',
        a.net || '',
        a.appliedV != null ? a.appliedV + ' V' : 'not traced',
        a.ratio != null ? Math.round(a.ratio * 100) + '%' : '',
        a.recommend ? a.recommend.minimumV + ' V' : '',
        a.recommend && a.recommend.standardV ? a.recommend.standardV + ' V' +
          (a.recommend.seriesSuggested ? ' (or series pair)' : '') : '',
        a.riskLabel + (a.railClass ? ', rail class ' + a.railClass : '')
      ].join('\t'));
    });

    var name = nBoards === 1 ? rows[0].assembly + '-replacement-caps.tsv'
                             : '5700a-replacement-caps.tsv';
    App.download(name, out.join('\n') + '\n', 'text/tab-separated-values');
    toast(rows.length + ' position(s) in ' + lines_.length + ' order line(s) → ' + name);
  }

  function renderFaultsPanel() {
    var d = BE.state.assembly;
    var codes = d.faultCodes || [];
    var q = el.searchInput.value.trim().toLowerCase();
    var shown = q ? codes.filter(function (c) {
      return (c.code + ' ' + c.title + ' ' + c.measure).toLowerCase().indexOf(q) >= 0;
    }) : codes;

    // "No fault code matches that" answers a question the reader only asked if
    // they typed something. A19 is the first board where the manual publishes
    // no codes at all, and there the search-empty wording turns a finding into
    // what looks like missing data -- the codes for its rails simply do not
    // exist, because a dead A19 stops the CPU that would report them.
    var empty = q ? 'No fault code matches that.'
                  : 'The service manual publishes no diagnostic fault code for ' +
                    d.id + '.';
    var html = section('Diagnostic fault codes', shown.length + ' pointing at ' + d.id,
      shown.length ? shown.map(faultHTML).join('') :
        '<div class="empty">' + empty + '</div>');

    if (d.caveats && d.caveats.length) {
      html += section('Watch out for', '',
        d.caveats.map(function (c) {
          return '<div class="step"><div class="step-head">' +
            '<span class="step-title">' + esc(c.title) + '</span></div>' +
            '<div class="step-text">' + esc(c.text) + '</div>' +
            '<div class="chiprow">' + (c.refs || []).map(chipHTML).join('') + '</div></div>';
        }).join(''));
    }

    (d.tables || []).forEach(function (t) {
      html += section(t.title, t.source || '',
        '<table class="readings"><tbody>' + t.rows.map(function (row) {
          return '<tr>' + Object.keys(row).map(function (k) {
            return '<td>' + esc(row[k]) + '</td>';
          }).join('') + '</tr>';
        }).join('') + '</tbody></table>' +
        (t.note ? '<div class="source-note">' + esc(t.note) + '</div>' : ''));
    });

    el.panelBody.innerHTML = html;
    bindList();
  }

  function faultHTML(c) {
    return '<div class="step">' +
      '<div class="step-head"><span class="step-n">' + esc(c.code) + '</span>' +
      '<span class="step-title">' + esc(c.title) + '</span></div>' +
      '<div class="step-text">' + esc(c.measure) + '</div>' +
      (c.expected ? '<div class="expect" style="margin:6px 0">' +
        '<div class="expect-value">' + esc(c.expected) + '</div>' +
        (c.com ? '<div class="expect-range">COM ' + esc(c.com) +
          (c.hi ? ' · HI ' + esc(c.hi) : '') + '</div>' : '') +
        '</div>' : '') +
      '<div class="step-text">' + esc(c.verdict) + '</div>' +
      '<div class="chiprow">' + (c.refs || []).map(chipHTML).join('') + '</div></div>';
  }

  /*
   * A step's measurements, entered where the step is read.
   *
   * Nothing here is required: a step may name four points and you may only
   * have taken two of them, so blank rows are simply not recorded. What is
   * typed survives a re-render (recording one row re-renders the panel), and a
   * row that has already been recorded says so rather than silently accepting
   * the same reading twice.
   */
  // Keyed by board as well as step and ref: step numbers restart at 1 on
  // every board and test point refs repeat, so '2/TP3' alone is a live row on
  // more than one assembly and a value typed on one would surface on another.
  function measureKey(stepN, ref) {
    var d = BE.state.assembly;
    return (d ? d.id : '') + '/' + stepN + '/' + ref;
  }

  function measureRowHTML(target, stepN) {
    var ref = target.ref || target.id;
    var key = measureKey(stepN, ref);
    var states = TP.states(target);
    var chosen = procState[key];
    if (chosen == null) chosen = Proc.stateIndexForStep(target, stepN);
    var st = states[Math.min(chosen, states.length - 1)];
    var typed = procEntries[key] == null ? '' : procEntries[key];
    var recorded = procRecorded[key];

    // A probe point is a place on a component ("the cathode of VR211"), so the
    // thing to light up on the board is that component.
    var locate = target.component || ref;

    var html = '<div class="measure-row" data-key="' + esc(key) + '" data-ref="' + esc(ref) + '"' +
      ' data-locate="' + esc(locate) + '" data-step="' + stepN + '">';
    html += '<div class="mr-head">' +
      '<button class="mr-ref" data-ref="' + esc(locate) + '">' + esc(ref) + '</button>' +
      '<span class="mr-sig">' + esc(target.signal || target.label || '') + '</span>' +
      (target.hazard ? '<span class="pill hazard">' + esc(target.hazard) + '</span>' : '') +
      '</div>';

    if (states.length > 1) {
      html += '<select class="mr-state">' + states.map(function (s, i) {
        return '<option value="' + i + '"' + (i === chosen ? ' selected' : '') + '>' +
          esc(s.label) + '</option>';
      }).join('') + '</select>';
    }

    html += '<div class="mr-expect">' + esc(TP.formatNominal(st, target.unit)) +
      '<span class="mr-range"> · accept ' + esc(TP.formatRange(st, target.unit)) +
      (target.refPoint ? ' · ref ' + esc(target.refPoint) : '') + '</span></div>';

    if (st && st.setup) {
      html += '<div class="expect-setup">Setup: ' + esc(st.setup) + '</div>';
    }

    html += '<div class="mr-entry">' +
      '<input type="text" inputmode="decimal" autocomplete="off" placeholder="not measured"' +
      ' value="' + esc(typed) + '">' +
      '<span class="mr-unit">' + esc(target.unit || 'V') + '</span>' +
      '<span class="mr-verdict"></span>' +
      (recorded ? '<span class="pill ok">recorded</span>' : '') +
      '</div>';
    return html + '</div>';
  }

  /** Live scoring under a row, without re-rendering the panel. */
  function updateMeasureRow(row) {
    var input = row.querySelector('input');
    var slot = row.querySelector('.mr-verdict');
    var target = targetFor(row.dataset.ref);
    if (!target || !slot) return;
    var value = readNumber(input.value);
    if (input.value.trim() === '' || isNaN(value)) { slot.textContent = ''; slot.className = 'mr-verdict'; return; }
    var states = TP.states(target);
    var idx = procState[row.dataset.key];
    if (idx == null) idx = Proc.stateIndexForStep(target, +row.dataset.step);
    var res = TP.evaluate(states[Math.min(idx, states.length - 1)], value);
    if (!res) { slot.textContent = ''; return; }
    var words = { pass: 'in tolerance', marginal: 'near limit', fail: 'out of tolerance',
                  unscored: 'recorded — no published limit' };
    slot.className = 'mr-verdict v-' + res.verdict;
    slot.textContent = words[res.verdict] +
      (res.pctOffNominal == null ? '' : ' · ' + res.pctOffNominal.toFixed(1) + '%');
  }

  /**
   * How a step stands, from the measurements it asked for.
   *
   * A fourteen-step procedure is worked through over an afternoon with a probe
   * in one hand, so the state of the whole thing has to be readable with every
   * card shut: which steps are finished, which are half done, and which found
   * something wrong. Typed values count as well as recorded ones -- a reading
   * you have taken is a reading you have taken, whether or not it has been
   * written to the log yet.
   */
  function stepStatus(step) {
    var d = BE.state.assembly;
    var targets = Proc.targets(d, step);
    var out = { total: targets.length, entered: 0, worst: null, unscored: 0 };
    var rank = { pass: 1, marginal: 2, fail: 3 };

    targets.forEach(function (target) {
      var ref = target.ref || target.id;
      var idx = procState[measureKey(step.n, ref)];
      if (idx == null) idx = Proc.stateIndexForStep(target, step.n);
      var raw = procEntries[measureKey(step.n, ref)];
      // readNumber, as everywhere a reading is judged: parseFloat scores
      // "17,4" as 17, so the badge would claim a verdict the live row refuses.
      var value = raw == null || String(raw).trim() === '' ? NaN : readNumber(raw);
      var verdict = null;

      if (!isNaN(value)) {
        var states = TP.states(target);
        var res = TP.evaluate(states[Math.min(idx, states.length - 1)], value);
        verdict = res ? res.verdict : 'unscored';
      } else {
        // Nothing typed: fall back to the log, so the summary survives a
        // reload and reflects work recorded in an earlier sitting.
        var logged = latestReading(ref, idx);
        if (logged) verdict = logged.verdict;
      }
      if (!verdict) return;
      out.entered++;
      if (verdict === 'unscored') out.unscored++;
      else if (!out.worst || rank[verdict] > rank[out.worst]) out.worst = verdict;
    });
    return out;
  }

  /**
   * Repaint one step's badge in place. Typing into a box has to move the
   * summary with it, but re-rendering the panel would take the focus out of
   * the box being typed into.
   */
  function updateStepStatus(stepN) {
    var d = BE.state.assembly;
    var proc = Proc.current(d);
    var step = proc && proc.steps.find(function (s) { return s.n === stepN; });
    var node = el.panelBody.querySelector('.step[data-step="' + stepN + '"]');
    if (!step || !node) return;

    var status = stepStatus(step);
    var head = node.querySelector('.step-head');
    var badge = head.querySelector('.step-state');
    if (badge) badge.remove();
    var done = head.querySelector('.pill.ok');
    var html = stepStatusHTML(status);
    if (html) {
      var span = document.createElement('span');
      span.innerHTML = html;
      head.insertBefore(span.firstChild, done || null);
    }
    ['s-pass', 's-marginal', 's-fail', 's-partial'].forEach(function (c) {
      node.classList.remove(c);
    });
    if (status.entered) {
      node.classList.add('s-' + (status.entered >= status.total
        ? (status.worst || 'pass') : 'partial'));
    }
  }

  /** The most recent reading for a point, in the mode this step asks about. */
  /**
   * The most recent reading at a point, across this unit's whole history.
   *
   * It used to see only the open session, so every step badge went blank after
   * a reload or an import -- exactly the moments when someone most wants to
   * know how far the last sitting got. The comment above stepStatus already
   * promised this behaviour; the code only ever delivered it within one visit.
   */
  function latestReading(ref, stateIndex) {
    var d = BE.state.assembly;
    var found = null;
    Log.sessions().forEach(function (session) {
      if (!d || session.assembly !== d.id) return;
      session.readings.forEach(function (r) {
        if (r.ref !== ref) return;
        if (stateIndex != null && (r.stateIndex || 0) !== stateIndex) return;
        if (!found || r.at > found.at) found = r;
      });
    });
    return found;
  }

  /** The badge a collapsed step wears: how far along it is, and how it went. */
  function stepStatusHTML(status) {
    if (!status.total) return '';
    if (!status.entered) return '';
    var complete = status.entered >= status.total;
    var tone = status.worst || (status.unscored ? 'unscored' : 'pass');
    var cls = complete ? 'v-' + tone : 'v-partial';
    var words = { pass: 'all in tolerance', marginal: 'near limit',
                  fail: 'out of tolerance', unscored: 'recorded' };
    var text = complete ? words[tone] || 'recorded'
                        : status.entered + ' of ' + status.total;
    return '<span class="step-state ' + cls + '" title="' + status.entered + ' of ' +
      status.total + ' measured">' + esc(text) + '</span>';
  }

  /** Test points and probe points share the panel, but not their id field. */
  function targetFor(ref) {
    var d = BE.state.assembly;
    return d.byRef[ref] || d.probeByRef[ref] || null;
  }

  /** Record every row of a step that has a value typed into it. */
  function recordStep(stepN) {
    var d = BE.state.assembly;
    var rows = el.panelBody.querySelectorAll('.measure-row[data-step="' + stepN + '"]');
    var pending = [];
    var refused = [];
    rows.forEach(function (row) {
      var raw = row.querySelector('input').value.trim();
      if (raw === '') return;                     // skipping a point is normal
      // readNumber, not parseFloat: a decimal comma or a pasted pair must be
      // refused here exactly as the live verdict beside the box refuses it,
      // or "17,4" records as 17 with a confident verdict.
      var value = readNumber(raw);
      if (isNaN(value)) { refused.push(raw); return; }
      pending.push({ row: row, ref: row.dataset.ref, key: row.dataset.key, value: value });
    });

    if (!pending.length) {
      // A refused box is not an empty one: the technician typed something,
      // and silence would read as recorded.
      toast(refused.length
        ? numberComplaint(refused[0], 'Nothing entered for step ' + stepN + ' yet')
        : 'Nothing entered for step ' + stepN + ' yet');
      return;
    }
    if (!Log.active() || Log.active().assembly !== d.id) {
      Log.start({ assembly: d.id });
      toast('Started a session to hold these readings');
    }

    var counts = { pass: 0, marginal: 0, fail: 0 };
    pending.forEach(function (p) {
      var target = targetFor(p.ref);
      var idx = procState[p.key];
      if (idx == null) idx = Proc.stateIndexForStep(target, stepN);
      var reading = Log.record(target, p.value, {
        stateIndex: idx,
        note: 'Procedure step ' + stepN
      });
      if (reading) {
        counts[reading.verdict] = (counts[reading.verdict] || 0) + 1;
        procRecorded[p.key] = true;
      }
    });

    var parts = [];
    if (counts.pass) parts.push(counts.pass + ' in tolerance');
    if (counts.marginal) parts.push(counts.marginal + ' near limit');
    if (counts.fail) parts.push(counts.fail + ' out of tolerance');
    toast('Recorded ' + pending.length + ' reading(s) — ' + parts.join(', ') +
      (refused.length
        ? '. Skipped "' + refused[0] + '" — ' + numberComplaint(refused[0], '')
        : ''));
    // Each Log.record re-rendered the panel before these flags were set, so
    // render once more to show which rows are now on the record.
    renderPanel();
  }

  function firstSentence(text) {
    var m = /^(.*?[.:])\s/.exec(text);
    return m ? m[1] : text.slice(0, 70);
  }

  function section(title, meta, body) {
    return '<section class="panel-section"><header>' + esc(title) +
      (meta ? '<span class="spacer"></span><span class="count">' + esc(meta) + '</span>' : '') +
      '</header>' + body + '</section>';
  }

  /* ================= panel interactions ================= */

  /**
   * Point at an item on the board from anywhere in the panel.
   *
   * Deliberately does not move the view: someone reading a procedure step is
   * looking at a particular part of the board already, and having it jump on
   * every hover would be worse than useless. The viewer draws an edge arrow
   * when the item happens to be out of frame.
   */
  function hoverRef(ref) {
    if (BE.state.hovered === ref) return;
    BE.set({ hovered: ref });
    viewer.draw();
    if (BE.state.display === 'split') secondary.draw();
  }

  function bindHover(node, ref) {
    if (!ref) return;
    node.addEventListener('mouseenter', function () { hoverRef(ref); });
    node.addEventListener('mouseleave', function () { hoverRef(null); });
    // Keyboard users get the same cue when tabbing through.
    node.addEventListener('focus', function () { hoverRef(ref); });
    node.addEventListener('blur', function () { hoverRef(null); });
  }

  /**
   * Wire up the markup in one or more panes.
   *
   * The panel body and the selected-part dock are rendered at different moments
   * -- the dock is filled after the list -- so each binds its own contents. The
   * lookups are scoped to the pane rather than to the document for the same
   * reason: two passes over the same element would leave two listeners on it,
   * and a "record" button that fires twice writes the reading twice.
   */
  function bindList(roots) {
    var panes = (roots || [el.panelBody]).filter(Boolean);
    var body = {
      querySelectorAll: function (sel) {
        var out = [];
        panes.forEach(function (r) {
          Array.prototype.push.apply(out, r.querySelectorAll(sel));
        });
        return out;
      }
    };
    function within(id) {
      for (var i = 0; i < panes.length; i++) {
        var hit = panes[i].querySelector('#' + id);
        if (hit) return hit;
      }
      return null;
    }

    body.querySelectorAll('.hitlist li').forEach(function (li) {
      li.addEventListener('click', function () { select(li.dataset.ref, { focus: true }); });
      // Enter and Space do what the click does -- the rows carry tabindex, and
      // a row a keyboard can reach but not press is worse than one it cannot
      // reach. preventDefault keeps Space from scrolling the list instead.
      li.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        select(li.dataset.ref, { focus: true });
      });
      bindHover(li, li.dataset.ref);
    });

    body.querySelectorAll('.chip').forEach(function (chip) {
      chip.addEventListener('click', function () { select(chip.dataset.ref, { focus: true }); });
      bindHover(chip, chip.dataset.ref);
    });

    body.querySelectorAll('[data-recap-family]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        recapFamily = btn.dataset.recapFamily;
        recapOpen = null;
        renderPanel();
      });
    });

    body.querySelectorAll('[data-recap-scope]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        recapScope = btn.dataset.recapScope;
        recapOpen = null;
        renderPanel();
      });
    });

    body.querySelectorAll('[data-recap-bulk]').forEach(function (chip) {
      chip.addEventListener('click', function () {
        var band = RECAP_BULK.find(function (b) { return b.id === chip.dataset.recapBulk; });
        if (!band) return;
        var hits = recapRows().filter(band.test);
        // Adds rather than replaces: the bands overlap, and someone ticking
        // ">= 80%" and then ">= 65%" means both, not the second instead.
        hits.forEach(function (a) { picks()[recapKey(a)] = true; });
        savePicks();
        toast(hits.length + ' ticked (' + band.label + ')');
        renderPanel();
      });
    });

    body.querySelectorAll('[data-recap-goto]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        gotoAssembly(btn.dataset.recapGoto);
      });
    });

    body.querySelectorAll('[data-recap-loss]').forEach(function (chip) {
      chip.addEventListener('click', function () {
        recapLoss = +chip.dataset.recapLoss;
        renderPanel();
      });
    });

    body.querySelectorAll('[data-recap-pick]').forEach(function (box) {
      box.addEventListener('click', function (e) { e.stopPropagation(); });
      box.addEventListener('change', function () {
        var k = box.dataset.recapPick;
        if (box.checked) picks()[k] = true; else delete picks()[k];
        savePicks();
        renderPanel();
      });
    });

    body.querySelectorAll('[data-recap-open]').forEach(function (head) {
      // One function for the click and for Enter/Space on the focused head.
      // The guard serves both: a press on the checkbox or a button inside the
      // row is that control's own business, whichever way it arrived.
      function toggleRecapRow(e) {
        if (e.target.closest('input,button')) return;
        var key = head.dataset.recapOpen;
        var parts = key.split('/');
        var asm = parts[0], ref = parts[1];
        if (recapOpen === key) { recapOpen = null; renderPanel(); return; }
        recapOpen = key;
        // Expanding a row is the start of working on that part, so bring the
        // board it is on up with it -- the drawing, the session and the
        // measurement boxes all follow the active assembly.
        if (!BE.state.assembly || BE.state.assembly.id !== asm) {
          gotoAssembly(asm, ref);
          // selectAssembly folds every row on a board switch, which is right
          // for the dropdown and wrong here: this switch was the click on the
          // row, and arriving with it folded means the click did nothing
          // visible and has to be made a second time on the other side.
          recapOpen = key;
          renderPanel();
          return;
        }
        select(ref, { focus: true });
        renderPanel();
      }
      head.addEventListener('click', toggleRecapRow);
      head.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        toggleRecapRow(e);
      });
    });

    body.querySelectorAll('.kindchip').forEach(function (chip) {
      chip.addEventListener('click', function () {
        var kind = chip.dataset.kind;
        activeKind = activeKind === kind ? null : kind;
        BE.set({
          // Over the whole board, not just its components, or picking the test
          // point chip would light up nothing on the drawing.
          highlighted: activeKind
            ? BE.items().filter(function (c) { return matchesKind(c, activeKind); })
                .map(function (c) { return c.ref; })
            : []
        });
        renderPanel();
        viewer.draw();
      });
    });

    // Only the head folds a step away. The body holds the boxes you type
    // measurements into, and a card that closes when you click its own input
    // cannot be filled in at all.
    body.querySelectorAll('.step .step-head').forEach(function (head) {
      function toggleStep(e) {
        if (e.target.closest('button')) return;
        var node = head.parentNode;
        var n = +node.dataset.step;
        // The fault-code and caveat blocks reuse .step-head with no step
        // number and nothing folded away; a press on those must do nothing,
        // not reach for a procedure the board may not even have.
        if (isNaN(n)) return;
        activeStep = activeStep === n ? null : n;
        var d = BE.state.assembly;
        var step = Proc.current(d).steps.find(function (s) { return s.n === n; });
        BE.set({ highlighted: activeStep && step ? step.refs.slice() : [] });
        renderPanel();
        viewer.draw();
      }
      head.addEventListener('click', toggleStep);
      head.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        toggleStep(e);
      });
    });

    body.querySelectorAll('.measure-row').forEach(function (row) {
      var key = row.dataset.key;
      var input = row.querySelector('input');

      // Hovering anywhere on the row points at the part on the board, so a
      // probe can be placed without hunting for the designator.
      bindHover(row, row.dataset.locate);

      input.addEventListener('input', function () {
        procEntries[key] = input.value;
        // Editing after recording means a new reading, not the old one.
        if (procRecorded[key]) {
          delete procRecorded[key];
          var pill = row.querySelector('.pill.ok');
          if (pill) pill.remove();
        }
        updateMeasureRow(row);
        updateStepStatus(+row.dataset.step);
      });

      input.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        // Enter moves to the next point of the step; on the last one it records.
        var rows = Array.prototype.slice.call(
          el.panelBody.querySelectorAll('.measure-row[data-step="' + row.dataset.step + '"]'));
        var next = rows[rows.indexOf(row) + 1];
        if (next) next.querySelector('input').focus();
        else recordStep(+row.dataset.step);
      });

      var stateSel = row.querySelector('.mr-state');
      if (stateSel) {
        stateSel.addEventListener('change', function () {
          procState[key] = +stateSel.value;
          renderPanel();
        });
      }

      var refBtn = row.querySelector('.mr-ref');
      if (refBtn && BE.lookup(refBtn.dataset.ref)) {
        refBtn.addEventListener('click', function () {
          select(refBtn.dataset.ref, { focus: true });
        });
      }

      updateMeasureRow(row);
    });

    var stateSelect = within('state-select');
    if (stateSelect) {
      stateSelect.addEventListener('change', function () {
        stateIndex = +stateSelect.value;
        renderPanel();
        if (pinned && BE.state.selected) showCardFor(BE.lookup(BE.state.selected), null, true);
      });
    }

    // Remembered replacement parts, in whichever of the two fitted-part forms
    // is on screen. Same memory behind both -- a part fitted from the Recap
    // round should be offered on the next component card and the other way
    // round.
    bindFittedHint(within('rf-part'), { 'rf-value': 'valueUF', 'rf-rated': 'ratedV' });
    bindFittedHint(within('rp-mfr'), { 'rp-fitted': 'desc', 'rp-fluke': 'fluke' });

    var measure = within('measure-input');
    if (measure) {
      measure.addEventListener('input', renderVerdictPreview);
      measure.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') saveReading();
      });
    }

    body.querySelectorAll('[data-meta]').forEach(function (input) {
      input.addEventListener('change', function () {
        var patch = {};
        patch[input.dataset.meta] = input.value;
        // The inputs already show what was typed, so the record can follow
        // them without rebuilding the panel. The rebuild fired on the blur
        // that moves focus to the next field and destroyed the element focus
        // was moving to, so the Tab or click landed on nothing -- filling in
        // the session header meant re-aiming after every field. The emit
        // still runs for anything else listening; only the refresh stands
        // down, and only for the duration of this synchronous write.
        suppressLogRefresh = true;
        try {
          Log.updateMeta(Log.active().id, patch);
        } finally {
          suppressLogRefresh = false;
        }
      });
    });

    body.querySelectorAll('[data-note]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        // The button knows which part its note belongs to; the selection may
        // by now be a different part, or nothing.
        Notes.remove(BE.state.assembly.id,
          btn.dataset.ref || BE.state.selected, btn.dataset.note);
      });
    });

    body.querySelectorAll('[data-reading]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        confirmDelete(btn, function () {
          Log.removeReading(btn.dataset.reading);
        });
      });
    });

    body.querySelectorAll('[data-service]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        serviceFilter = btn.dataset.service || null;
        refresh();
      });
    });

    body.querySelectorAll('[data-repair]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        confirmDelete(btn, function () {
          Log.removeRepair(btn.dataset.repair);
          refresh();
        });
      });
    });

    // Changing the quantity changes which units make sense for it, so the
    // unit list has to follow: offering microfarads for a resistance reading
    // is how a wrong number gets stored with a straight face.
    var quantity = within('cq-quantity');
    if (quantity) {
      quantity.addEventListener('change', function () {
        measureQuantity = quantity.value;
        refresh();
      });
    }

    body.querySelectorAll('[data-act]').forEach(function (btn) {
      btn.addEventListener('click', function () { action(btn.dataset.act, btn); });
    });
  }

  var armedDelete = null;   // { btn, timer, label } — at most one at a time

  /**
   * Deletion in two presses. The × glyphs on readings, repairs and sweeps
   * remove service history that has no other copy, sit at the end of every
   * row, and used to act on the first touch -- a mis-click at arm's length
   * erased a reading with nothing said and nothing to undo. The first press
   * arms the button and shows it; only a second press on the same button,
   * within a few seconds, deletes. Anything else -- the timer running out,
   * arming a different delete, any re-render replacing the button -- stands
   * it down.
   */
  function confirmDelete(btn, fn) {
    if (armedDelete && armedDelete.btn === btn) {
      disarmDelete();
      fn();
      return;
    }
    disarmDelete();
    armedDelete = { btn: btn, label: btn.textContent,
                    timer: setTimeout(disarmDelete, 4000) };
    btn.textContent = 'sure?';
    btn.classList.add('is-armed');
  }

  function disarmDelete() {
    if (!armedDelete) return;
    clearTimeout(armedDelete.timer);
    // The button may already have been replaced by a re-render; restoring a
    // detached node is harmless, and the fresh copy renders unarmed.
    armedDelete.btn.textContent = armedDelete.label;
    armedDelete.btn.classList.remove('is-armed');
    armedDelete = null;
  }

  function action(act, btn) {
    var d = BE.state.assembly;
    if (act === 'recap-all') {
      var rows = recapRows();
      var allPicked = rows.length && rows.every(function (a) { return picks()[recapKey(a)]; });
      rows.forEach(function (a) {
        if (allPicked) delete picks()[recapKey(a)];
        else picks()[recapKey(a)] = true;
      });
      savePicks();
      renderPanel();
      return;
    }
    if (act === 'recap-clear-all') {
      var n = Object.keys(picks()).length;
      if (!global.confirm('Clear all ' + n + ' ticked capacitors, on every board?')) return;
      recapPicked = {};
      savePicks();
      toast('Selection cleared');
      renderPanel();
      return;
    }
    if (act === 'recap-bom') { recapBOM(); return; }
    if (act === 'recap-consolidate') { recapConsolidate = !recapConsolidate; renderPanel(); return; }
    if (act === 'recap-measure') { recapMeasure(btn.dataset.ref); return; }
    if (act === 'recap-removed') { recapMarkRemoved(btn.dataset.ref); return; }
    if (act === 'recap-fitted') { recapSaveFitted(btn.dataset.ref); return; }
    // A recap row's button names its own part; only the dock's, which is
    // always the selected part's, may fall back to the selection.
    if (act === 'show-board') showOnBoard((btn && btn.dataset.ref) || BE.state.selected);
    else if (act === 'show-sch') showOnSchematic(BE.state.selected);
    else if (act === 'save-reading') saveReading();
    else if (act === 'fit-toggle') {
      // Ticking a board is itself the record: the note beside it says why, and
      // both go into the entry so the reasoning survives the next tick.
      var fitNote = ((document.getElementById('fit-note') || {}).value || '').trim();
      Log.setFitment(btn.dataset.id, btn.checked ? 'fitted' : 'removed', fitNote);
      toast(btn.dataset.id + (btn.checked ? ' fitted' : ' out') +
            (fitNote ? ' — ' + fitNote : ''));
    }
    else if (act === 'fit-swap') {
      // The slot still holds a board, just not the same one. Kept separate
      // from "fitted" because the two answer different questions later:
      // whether the instrument was complete, and whether the board under test
      // was still the original one.
      var swapNote = ((document.getElementById('fit-note') || {}).value || '').trim();
      Log.setFitment(btn.dataset.id, 'swapped', swapNote);
      toast(btn.dataset.id + ' swapped for another board' +
            (swapNote ? ' — ' + swapNote : ''));
    }
    else if (act === 'fit-undo') {
      Log.removeFitment(btn.dataset.id);
      toast('Entry removed');
    }
    else if (act === 'add-session-note') {
      var sn = document.getElementById('session-note-input');
      if (!sessionHere()) {
      toast('Start a session for ' + BE.state.assembly.id + ' first'); return;
    }
      if (sn && sn.value.trim()) {
        Log.addSessionNote(sn.value);
        toast('Note added to this visit');
      }
    } else if (act === 'del-session-note') {
      Log.removeSessionNote(btn.dataset.id);
    } else if (act === 'add-note') {
      // The notes block can be on screen twice -- once in an open recap row,
      // once in the dock -- and both carry id="note-input", so a lookup by id
      // finds whichever comes first in the document, not the one whose button
      // was pressed. The textarea sits in the field just above the button's
      // own row; the ref rides on the button itself.
      var noteRef = (btn && btn.dataset.ref) || BE.state.selected;
      var noteWrap = btn && btn.parentNode ? btn.parentNode.previousElementSibling : null;
      var input = (noteWrap && noteWrap.querySelector('textarea')) ||
        document.getElementById('note-input');
      if (noteRef && input && input.value.trim()) {
        Notes.add(d.id, noteRef, input.value);
        toast('Note added to ' + noteRef);
      }
    } else if (act === 'start-session') {
      var typedSerial = ((document.getElementById('meta-serial') || {}).value || '').trim();
      // On a first run this is the only serial field on screen, and it used to
      // name the visit and nothing else: the unit stayed nameless, the report
      // printed "Serial: not recorded", and the export carried an empty serial
      // -- which can never merge with the same instrument logged elsewhere,
      // because units are matched on serial. If the unit has no serial yet,
      // this is it. An existing serial is left alone; that is a correction, and
      // corrections go through the unit itself rather than a session form.
      var here = Units.ensure();
      if (typedSerial && !(here.serial || '').trim()) {
        Units.update(here.id, { serial: typedSerial });
        renderUnitPicker();
      }
      Log.start({
        assembly: d.id,
        instrumentSerial: typedSerial,
        technician: (document.getElementById('meta-tech') || {}).value || ''
      });
      toast('Session started');
    } else if (act === 'new-session') {
      Log.start({ assembly: d.id });
      toast('New session started');
    } else if (act === 'export-json') {
      // This unit only. A log is opened to carry on working on one instrument,
      // and handing over every calibrator on the bench to do that is more than
      // was asked for.
      var unit = Units.active();
      download(Service.filename(unit, 'json'),
        JSON.stringify(Service.exportAll([unit.id]), null, 1), 'application/json');
      standDownAlarm();
      toast('Readings, repairs and notes for ' + Units.label(unit) + ' — one file');
    } else if (act === 'export-all-units') {
      download(Service.filename({ serial: 'all-units' }, 'json'),
        JSON.stringify(Service.exportAll(), null, 1), 'application/json');
      standDownAlarm();
    } else if (act === 'export-csv') {
      download(Service.filename(Units.active(), 'csv'), Log.exportCSV(), 'text/csv');
      standDownAlarm();
    } else if (act === 'export-report') {
      var forReport = Units.active();
      download(Service.filename(forReport, 'html'),
        Service.report(forReport), 'text/html');
      standDownAlarm();
      toast('Report written — open it in a browser and print to PDF');
    } else if (act === 'import-log') {
      importFile(function (payload) {
        var r = Service.importAll(payload);
        renderUnitPicker();
        // Opening a log used to leave no session active, so the panel announced
        // "No open session" over a file that had just brought in a hundred
        // readings -- and the obvious next click, Start session, would have made
        // a spurious empty one beside them. Adopt the imported session for the
        // board on screen, the same way switching boards does.
        selectAssembly(BE.state.assembly.id);
        var bits = [];
        if (r.units) bits.push(r.units + ' unit(s)');
        if (r.sessions) bits.push(r.sessions + ' session(s)');
        if (r.notes) bits.push(r.notes + ' note(s)');
        toast(bits.length
          ? 'Opened ' + r.kind + ': added ' + bits.join(', ') +
            (r.serials && r.serials.length ? ' — ' + r.serials.join(', ') : '')
          : 'Nothing new in that file — it is already open here');
      });
    } else if (act === 'record-component') {
      recordComponent();
    } else if (act === 'record-pins') {
      recordPinSweep();
    } else if (act === 'clear-pins') {
      forEachPinInput(function (inp) { inp.value = ''; });
      var first = el.detailDockBody.querySelector('.pin-v');
      if (first) first.focus();
    } else if (act === 'del-pins') {
      confirmDelete(btn, function () {
        Log.removeReading(btn.dataset.id);
        refresh();
      });
    } else if (act === 'mark') {
      if (!sessionHere()) { Log.start({ assembly: d.id }); }
      pendingRepair = { ref: BE.state.selected, status: btn.dataset.status };
      // Opening and closing the form changes nothing the event bus knows
      // about, so the re-render has to be asked for here.
      refresh();
    } else if (act === 'cancel-repair') {
      pendingRepair = null;
      refresh();
    } else if (act === 'save-repair') {
      saveRepair(btn.dataset.status);
    } else if (act === 'record-step') {
      recordStep(+btn.dataset.step);
    } else if (act === 'step-done') {
      var n = +btn.dataset.step;
      Proc.setDone(d.id, n, !Proc.isDone(d.id, n));
    } else if (act === 'reset-procedure') {
      Proc.reset(d.id);
    }
  }

  function forEachPinInput(fn) {
    var grid = el.detailDockBody ? el.detailDockBody.querySelector('#pin-grid') : null;
    if (!grid) return;
    Array.prototype.forEach.call(grid.querySelectorAll('.pin-v'), fn);
  }

  /**
   * Parse a pasted block of pin readings.
   *
   * Accepts the shape people already write in free-form notes -- "1: 0.45"
   * one per line -- and also a bare run of numbers, which fills forward from
   * whichever pin was focused. Commas, tabs, newlines and semicolons all
   * separate; a decimal comma would be ambiguous against a separator, so only
   * the full stop is a decimal point here.
   */
  function parsePinPaste(text, startPin) {
    var out = [];
    var labelled = /(^|[\s,;])(\d{1,2})\s*[:=]\s*(-?\d*\.?\d+)/g;
    var m, found = false;
    while ((m = labelled.exec(text))) {
      found = true;
      out.push({ pin: +m[2], v: parseFloat(m[3]) });
    }
    if (found) return out;
    var bare = text.split(/[\s,;]+/).filter(function (t) { return t !== ''; });
    var pin = startPin || 1;
    bare.forEach(function (t) {
      var v = parseFloat(t);
      if (!isNaN(v)) out.push({ pin: pin, v: v });
      pin++;
    });
    return out;
  }

  function applyPinValues(pairs) {
    var byPin = {};
    pairs.forEach(function (p) { byPin[p.pin] = p.v; });
    forEachPinInput(function (inp) {
      var v = byPin[+inp.dataset.pin];
      if (v != null) inp.value = String(v);
    });
  }

  function recordPinSweep() {
    var item = BE.state.selected ? BE.lookup(BE.state.selected) : null;
    if (!item) return;
    var d = BE.state.assembly;
    // Read the form before touching the log. Starting a session emits, the
    // emit re-renders the dock, and the re-render replaces these inputs with
    // empty ones -- so opening a session first silently threw away everything
    // just typed and reported "enter at least one pin voltage".
    var pins = [];
    var refused = [];
    forEachPinInput(function (inp) {
      var raw = inp.value.trim();
      if (raw === '') return;
      // readNumber, not parseFloat, for the reason it exists: a cell holding
      // "0,45" must be refused out loud, not filed as 0 in silence. And a
      // refused cell is not an empty one -- something was typed, and saying
      // nothing about it would read as saved.
      var v = readNumber(raw);
      if (isNaN(v)) { refused.push(raw); return; }
      pins.push({ pin: +inp.dataset.pin, v: v });
    });
    if (!pins.length) {
      toast(refused.length
        ? numberComplaint(refused[0], 'Enter at least one pin voltage')
        : 'Enter at least one pin voltage');
      return;
    }
    var countEl = el.detailDockBody.querySelector('#pin-count');
    var condEl = el.detailDockBody.querySelector('#pin-condition');
    var refEl = el.detailDockBody.querySelector('#pin-ref');
    var count = countEl ? +countEl.value : null;
    var condition = condEl ? condEl.value.trim() : '';
    var refPoint = refEl ? refEl.value.trim() : '';
    if (!sessionHere()) Log.start({ assembly: d.id });
    var rec = Log.recordPins(item, {
      pins: pins,
      pinCount: count,
      condition: condition,
      refPoint: refPoint
    });
    if (!rec) { toast('Nothing recorded'); return; }
    // The count is on the saved reading now, so the in-flight override has
    // done its job and must not outlive it.
    pendingPinCount = null;
    pendingPinValues = null;
    toast(pins.length + ' pin' + (pins.length === 1 ? '' : 's') + ' recorded on ' + item.ref +
      (refused.length
        ? '. Skipped "' + refused[0] + '" — ' + numberComplaint(refused[0], '')
        : ''));
    refresh();
  }

  function recordComponent() {
    var item = BE.state.selected ? BE.lookup(BE.state.selected) : null;
    if (!item) return;
    var rawValue = (document.getElementById('cq-value') || {}).value;
    var value = readNumber(rawValue);
    if (isNaN(value)) {
      toast(numberComplaint(rawValue, 'Enter a measured value first')); return;
    }
    var d = BE.state.assembly;
    // The whole form is read before the log is touched, in recordPinSweep's
    // order: starting a session emits, the emit re-renders this form, and a
    // control read after that is back at its default -- the unit reverts to
    // the parts-list unit and the in-circuit box to checked, silently, while
    // the typed value survives in a variable.
    var quantity = (document.getElementById('cq-quantity') || {}).value;
    var unit = (document.getElementById('cq-unit') || {}).value;
    var inCircuit = (document.getElementById('cq-incircuit') || {}).checked;
    if (!sessionHere()) Log.start({ assembly: d.id });
    var elim = quantity === 'esr' && global.Caps ? Caps.esrLimit(item) : null;
    var reading = Log.recordComponent(item, {
      quantity: quantity, value: value, unit: unit, inCircuit: inCircuit,
      esrLimit: elim ? elim.maxESR : null
    });
    if (!reading) { toast('Could not record that'); return; }
    measureQuantity = quantity;
    var words = { pass: 'matches the parts list', marginal: 'near the limit',
                  fail: 'OUT OF SPEC', unscored: 'recorded' };
    toast(item.ref + ' ' + Parts.format(reading.base, quantity, reading.unit) + ' — ' +
      (words[reading.verdict] || 'recorded') +
      (reading.pctOffNominal != null
        ? ' (' + (reading.pctOffNominal > 0 ? '+' : '') +
          reading.pctOffNominal.toFixed(1) + '%)' : ''));
    refresh();
  }

  function saveRepair(status) {
    var item = BE.state.selected ? BE.lookup(BE.state.selected) : null;
    if (!item) return;
    var val = function (id) {
      var node = document.getElementById(id);
      return node ? node.value.trim() : '';
    };
    var opts = { status: status, symptom: val('rp-symptom') };
    if (status === 'replaced') {
      opts.removed = { desc: val('rp-removed'), fluke: item.fluke || '',
                       mfrPart: item.mfrPart || '' };
      opts.fitted = { desc: val('rp-fitted'), fluke: val('rp-fluke'),
                      mfrPart: val('rp-mfr'),
                      substitute: !!(document.getElementById('rp-sub') || {}).checked };
    }
    if (!sessionHere()) Log.start({ assembly: BE.state.assembly.id });
    Log.addRepair(item, opts);
    pendingRepair = null;
    toast(item.ref + ' marked ' + status + ' on ' + Units.label(Units.active()));
    refresh();
  }

  function saveReading() {
    var input = document.getElementById('measure-input');
    if (!input) return;
    var value = readNumber(input.value);
    if (isNaN(value)) {
      toast(numberComplaint(input.value, 'Enter a measured value first')); return;
    }
    // A rail sweep starts at the first test point, not in the Log tab.
    // Refusing here sent the reader off to open a session and come back,
    // which is the round trip this box exists to remove; marking a part
    // faulty has opened its own session for the same reason since it was
    // added.
    var started = false;
    if (!sessionHere()) {
      Log.start({ assembly: BE.state.assembly.id });
      started = true;
    }
    // After the session, not before it. Log.start emits, and the emit rebuilds
    // the dock synchronously -- a flag set above it is spent on that rebuild
    // and the one that matters, after the reading is written, sees it already
    // cleared. The caret then lands nowhere on exactly the first reading of a
    // sweep, which is the one that opens the session.
    measureWantsFocus = true;
    var tp = BE.lookup(BE.state.selected);
    var reading = Log.record(tp, value, { stateIndex: stateIndex });
    if (reading) {
      var words = { pass: 'in tolerance', marginal: 'near limit', fail: 'OUT OF TOLERANCE',
                    unscored: 'recorded — the manual publishes no limit for it' };
      // One toast, because there is only one toast element and a second call
      // overwrites the first before it can be read. A session is what the
      // reading gets filed under, so its opening rides along with the verdict
      // rather than being announced and then immediately painted over.
      toast(tp.ref + ' ' + TP.fmt(value) + ' ' + (tp.unit || 'V') + ' — ' + words[reading.verdict] +
        (started ? ' · new session on ' + Units.label(Units.active()) : ''));
    }
  }

  /* ================= status ================= */

  function renderStatus() {
    var d = BE.state.assembly;
    var sel = BE.state.selected ? BE.lookup(BE.state.selected) : null;
    var following = document.body.classList.contains('follower');
    // With more than one board loaded, the tab should say which one is open.
    // A follower says so in its title as well: on a two-monitor bench the two
    // windows are otherwise indistinguishable in alt-tab, and only one of
    // them is the one to work in.
    document.title = (following ? 'Linked view — ' : '5700A Atlas — ') +
      d.id + ' ' + d.name;
    el.statusLeft.innerHTML =
      '<b>' + esc(d.id) + '</b> ' + esc(d.name) + ' · PCA ' + esc(d.pca) +
      (d.rev ? ' rev ' + esc(d.rev) : '') +
      ' · ' + esc(d.refs.locator) + ' · ' + esc(d.refs.parts) +
      (sel ? ' — selected <b>' + esc(sel.ref) + '</b>' : '');
    // A follower's topbar name, kept in step with whatever board the leader
    // has open -- this runs on every refresh, same as the status bar it
    // mirrors.
    if (el.followerAssembly) el.followerAssembly.textContent = d.id + ' — ' + d.name;
    // A follower can only do what its own keyboard whitelist lets through;
    // the full legend below would name keys that do nothing here. The legend
    // names the window too: it is the cheapest place to answer "why can't I
    // record in this one?" before it is asked.
    el.statusRight.textContent = following ?
      'Linked view · 1-6 display · Z fit · Esc hides card' :
      '/ search · B T L P F R modes · 1-6 display · S schematic · D detail · M measure · Z fit';
  }

  /**
   * How much of this board the dataset actually covers.
   *
   * A progress report on building the dataset, which is Author Mode's job.
   * Someone servicing a calibrator is not tracking how many parts have been
   * placed yet; they are looking for one of them.
   */
  function renderCoverage() {
    el.coverageBadge.hidden = !BE.state.author;
    if (el.coverageBadge.hidden) return;
    var d = BE.state.assembly;
    var all = BE.items(d);
    var placeable = all.filter(function (i) { return !i.notOnDrawing; });
    var placed = placeable.filter(function (i) { return i.board; }).length;
    var verified = all.filter(function (i) { return i.verified; }).length;
    var sch = all.filter(function (i) { return (i.sch || []).length; }).length;
    el.coverageBadge.textContent =
      placed + '/' + placeable.length + ' placed · ' + verified + ' checked by hand · ' +
      sch + ' on schematic';
    el.coverageBadge.style.color = placed === placeable.length ? '' : 'var(--marginal)';
    el.coverageBadge.title = (all.length - placeable.length) +
      ' parts carry no silkscreen designator on the drawing';
  }

  /* ================= helpers ================= */

  var toastTimer = null;
  /**
   * A measured number, or NaN if the text does not unambiguously hold one.
   *
   * parseFloat stops at the first character it cannot use and keeps what it
   * has, which is right for "0.28V" and "12.3 V rms" -- a value with its unit
   * written after it -- and badly wrong for the two cases below.
   *
   *   "17,4"    a decimal comma. parseFloat returns 17, and the reading goes
   *             into the record scored, with a confident verdict, an order of
   *             magnitude out. This is a 1988 instrument common in European
   *             labs, so the comma is not a typo, it is how the number is
   *             written. Guessing between 17.4 and 174 would be a second
   *             invention on top of the first, so this refuses instead.
   *   "0.2 0.3" two numbers. parseFloat keeps the first and discards the rest
   *             in silence.
   *
   * The rule that separates them: parse the leading number, then look at what
   * follows. Trailing letters are a unit and are fine; a trailing digit means
   * the text held more than one number and we cannot tell which was meant.
   */
  function readNumber(raw) {
    var text = String(raw == null ? '' : raw).trim();
    if (text === '') return NaN;
    if (text.indexOf(',') >= 0) return NaN;
    var value = parseFloat(text);
    if (isNaN(value)) return NaN;
    var lead = text.match(/^[+-]?[\d.]+(e[+-]?\d+)?/i);
    if (/\d/.test(text.slice(lead ? lead[0].length : 0))) return NaN;
    return value;
  }
  App.readNumber = readNumber;

  /** Why a number was refused, for a message that says what to do about it. */
  function numberComplaint(raw, ifEmpty) {
    var text = String(raw == null ? '' : raw).trim();
    if (text === '') return ifEmpty;
    if (text.indexOf(',') >= 0) {
      return 'Use a decimal point, not a comma — "' + text + '" could be two ' +
             'different numbers and this will not guess.';
    }
    return 'That does not read as a single measured value.';
  }

  function toast(message) {
    // A live storage alarm outranks routine confirmations. Every recording
    // path toasts its result immediately after the write, and the write that
    // just failed is the one thing that toast must not paper over -- the
    // alarm was on screen for the time between two synchronous statements.
    // It yields once a write succeeds again or an export has carried the
    // readings out of memory.
    if (Log.storageFailed && el.toast.classList.contains('is-alarm')) return;
    el.toast.textContent = message;
    el.toast.hidden = false;
    el.toast.classList.remove('is-alarm');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.toast.hidden = true; }, 2600);
  }
  App.toast = toast;

  /**
   * The storage alarm has been answered: an export just carried the readings
   * out of memory, so the toast slot may speak of other things again. The
   * next failed write raises it anew.
   */
  function standDownAlarm() {
    el.toast.classList.remove('is-alarm');
  }

  function download(filename, text, mime) {
    var blob = new Blob([text], { type: mime || 'text/plain' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }
  App.download = download;

  function importFile(handler) {
    el.fileInput.value = '';
    el.fileInput.onchange = function () {
      var file = el.fileInput.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        try {
          handler(JSON.parse(reader.result));
        } catch (err) {
          toast('Could not read that file: ' + err.message);
        }
      };
      reader.readAsText(file);
    };
    el.fileInput.click();
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  App.esc = esc;
  App.refresh = function () { refresh(); };
  App.viewer = function () { return viewer; };

  global.App = App;
})(window);
