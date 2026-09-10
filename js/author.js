/*
 * author.js — the editor behind ?author=1.
 *
 * Everything the dataset holds about an item is editable here: where it sits on
 * the board, where it sits on each schematic sheet, and every field on the
 * record including the per-mode expectations of a +/-PA test point. Edits
 * mutate the loaded dataset and are mirrored to localStorage continuously, so
 * closing the tab loses nothing; "Export" writes the files back out.
 *
 * Two exports, because the two halves have different owners:
 *   data/<asm>.coords.json  geometry -- regenerated freely, safe to overwrite
 *   data/<asm>.js           the whole dataset, when metadata was edited too
 *
 * Every edit is undoable. A marker dragged off the edge of the board is
 * otherwise unreachable -- there is nothing left to click -- so an editor that
 * can move things has to be able to move them back.
 */
(function (global) {
  'use strict';

  var BE = global.BoardExplorer;
  var Geom = global.Geom;

  var api = {};
  var host = null;
  var armedRef = null;        // ref waiting to be placed by the next gesture
  var landmarkMode = false;
  var pendingLandmark = null; // board point awaiting its photo counterpart
  var dirty = false;

  // Outline alignment. Clicking pairs of features is precise but slow, and it
  // asks you to find the same speck twice; lining the board's own edge up is
  // how someone actually judges whether a photo is registered. So this mode
  // pins the photograph's four corners as a draggable quad: drag a corner and
  // the photograph slides and warps under the drawing in real time, until the
  // blue board edge sits under the drawn one.
  //
  // It is the same four {src,dst} pairs the landmark solver already takes --
  // dst held at the photo's own corners, src the board point each is dragged
  // to -- so no new schema, no second solver, and Undo covers it.
  var outlineMode = false;
  var outlineQuad = null;     // [{src,dst}] x4 while the mode is open
  var outlineDrag = null;     // { i, snapped }
  var OUTLINE_GRAB = 14;      // px; the corners sit on the edge, so aim generously
  // Named, because these four end up in <asm>.coords.overrides.json beside
  // landmarks named after the part they sit on, and four unlabelled pairs
  // there would say nothing about how the alignment was arrived at.
  var PHOTO_CORNERS = [
    { at: [0, 0], note: 'photo corner, top left' },
    { at: [1, 0], note: 'photo corner, top right' },
    { at: [1, 1], note: 'photo corner, bottom right' },
    { at: [0, 1], note: 'photo corner, bottom left' }
  ];

  var DEFAULT_SIZE = { w: 0.018, h: 0.022 };
  var MIN_SIZE = 0.004;
  // Exactly the outlines Viewer.pathShape draws. 'polarised-can', 'to-220',
  // 'dip' and 'sip' were offered here and all four rendered as a plain box, so
  // the picker promised four package outlines it did not have.
  var SHAPES = ['rect', 'circle', 'point'];
  var OFF_BOARD = 0.02;       // how far outside board space counts as "lost"

  // What the next outline drawn will be. Held across placements, because a run
  // of round cans is one choice rather than thirty, and re-seeded from the
  // selection so redrawing a circle does not silently turn it into a box.
  var drawShape = 'rect';
  var snapOn = true;          // fit a swept shape to the ink under it
  var snapWarned = false;
  var DRAW_TOOLS = [
    { id: 'rect', label: 'Box', key: 'b',
      hint: 'Drag corner to corner. Shift for a square, Alt from the centre.' },
    { id: 'circle', label: 'Circle', key: 'c',
      hint: 'Drag across the middle, rim to rim. Alt from the centre.' },
    { id: 'point', label: 'Point', key: 'p',
      hint: 'A small circle for a pad. Drag across it, rim to rim.' }
  ];

  var undoStack = [];
  var redoStack = [];
  var armed = false;          // arm() has attached the editing behaviour
  var UNDO_LIMIT = 100;
  var baselines = {};         // positions as shipped, per assembly

  // Which drawing of the selected part the pointer last chose. A part can be
  // drawn more than once on a sheet and selection is by designator alone, so
  // without this every keyboard edit and every handle lands on the first
  // occurrence rather than the symbol that was just clicked.
  var selOcc = null;          // { ref, occurrence } or null

  function key() { return 'fluke5700a.author.' + (BE.state.assembly || {}).id; }

  var Author = {
    init: function (h) {
      host = h;

      // Saved edits apply whether or not Author Mode is on.
      //
      // adopt() snapshots the shipped positions as the undo baseline and then
      // restores whatever is in local storage over the top, and it used to sit
      // below the guard -- so a correction only existed while ?author=1 was in
      // the URL. That made the editor feel like it had done nothing: move a
      // marker onto the part it actually labels, go back to using the tool at
      // the bench, and the marker is wrong again.
      //
      // An edit is an improvement to the data, not a private draft. Both modes
      // show the same board; Author Mode adds the ability to change it, and what
      // it gates is the editing -- the handles, the panel, the coverage badge.
      // Exporting and folding into data/<asm>.coords.overrides.json is still how
      // an edit becomes permanent for everyone else; this is about the person
      // who made it seeing it on their own bench.
      BE.on('registered', adopt);
      BE.list().forEach(adopt);

      if (BE.state.author) Author.arm();
    },

    /**
     * Attach the editing behaviour.
     *
     * Idempotent, and safe to call long after load — which is what lets the
     * Author tab be a toggle instead of a URL you have to type. Everything in
     * init() has already run by now, including restoring saved edits; this is
     * only the part that makes the board editable.
     */
    arm: function () {
      if (armed) return;
      armed = true;
      // History belongs to one assembly: its entries hold that dataset's own
      // objects, and undoing them after a switch would edit a board that is no
      // longer on screen and save it under the wrong key.
      BE.on('state', function (changed) {
        if (changed.indexOf('assembly') >= 0) {
          undoStack.length = 0;
          redoStack.length = 0;
          // An arm names a part in the dataset that just left the screen.
          armedRef = null;
          api.draw = null;
          selOcc = null;
        }
        // A pointer's choice of occurrence describes one part only; it holds
        // across a re-selection of the same part but not across a new one.
        if (changed.indexOf('selected') >= 0 &&
            !(selOcc && selOcc.ref === BE.state.selected)) {
          selOcc = null;
        }
        // Reach for a circle and it stays a circle: the tool follows what the
        // selected part already is, so redrawing it keeps its own outline
        // without anyone having to notice the picker.
        if (changed.indexOf('selected') >= 0 && BE.state.selected) {
          var g = geometryOf(BE.state.selected, currentSpace());
          if (g && g.shape && SHAPES.indexOf(g.shape) >= 0) drawShape = g.shape;
        }
      });
      document.addEventListener('keydown', onKeyDown);
      // Shift and Alt are read from the keyboard rather than from the pointer
      // event, because the viewer's drag callback carries a position and no
      // modifiers -- and holding Shift halfway through a sweep is exactly when
      // you discover you wanted a square.
      document.addEventListener('keyup', trackModifiers);
    },

    /* ---- pointer handling on the canvas ---- */

    onPointerDown: function (e, pos, hit, viewer) {
      if (!BE.state.author) return false;

      if (landmarkMode) {
        addLandmarkPoint(viewer, pos);
        return true;
      }
      if (outlineMode) {
        var oi = outlineHandleAt(viewer, pos);
        // Only a corner starts a drag. A press anywhere else falls through to
        // pan, so the board can still be moved and zoomed while aligning --
        // which is most of the work at the precision this wants.
        if (oi >= 0) { outlineDrag = { i: oi }; return true; }
        return false;
      }
      if (armedRef) {
        // The press only opens the gesture. Whether it turns out to be a click
        // or a swept outline is not known until the pointer comes up, so
        // nothing is written to the item until then.
        api.draw = {
          ref: armedRef,
          space: viewer.space,
          shape: drawShape,
          start: pos,
          now: pos,
          square: !!e.shiftKey,
          fromCentre: !!e.altKey
        };
        return true;
      }

      // A handle on the selection outranks whatever marker is underneath it:
      // the handles are small and sit on the border, where another marker is
      // exactly what you are trying to size the box against.
      var handle = handleAt(viewer, pos);
      if (handle) {
        var entry = selectedEntry(viewer);
        api.drag = {
          ref: BE.state.selected,
          occurrence: entry ? entry.occurrence : null,
          space: viewer.space,
          mode: 'resize',
          handle: handle,
          origin: Object.assign({}, geometryOf(BE.state.selected, viewer.space,
            entry ? entry.occurrence : null)),
          start: viewer.screenToSpace(pos[0], pos[1])
        };
        return true;
      }

      hit = grabTarget(viewer, pos, hit);
      noteHit(hit);
      if (hit && (e.altKey || e.shiftKey || e.metaKey || e.ctrlKey || isSelected(hit.ref))) {
        BE.set({ selected: hit.ref });
        api.drag = {
          ref: hit.ref,
          occurrence: hit.occurrence,
          space: viewer.space,
          mode: e.altKey ? 'resize' : 'move',
          // A copy, not the live object: every move event measures from where
          // the drag started, and sharing the object would make each one
          // measure from the last, so the marker would accelerate away.
          origin: Object.assign({}, geometryOf(hit.ref, viewer.space, hit.occurrence)),
          start: viewer.screenToSpace(pos[0], pos[1])
        };
        return true;
      }
      return false;
    },

    onDrag: function (drag, pos, viewer) {
      if (outlineDrag) {
        var p = viewer.screenToSpace(pos[0], pos[1]);
        // Snapshot on first movement, not on press, so grabbing a corner and
        // letting go does not fill the history with no-ops.
        if (!outlineDrag.snapped) {
          outlineDrag.snapped = true;
          pushUndo(layerEntry(landmarkStore(), 'align outline'));
        }
        outlineQuad[outlineDrag.i].src = [p[0], p[1]];
        applyOutline();
        // draw() repaints the canvas -- markers, handles, the quad -- but the
        // photo is an <img> the viewer positions with a CSS transform, and only
        // applyLayerTransforms() rewrites that. Without this the handles moved
        // and the photograph stayed put until something else forced a full
        // re-render, which is what switching display modes did.
        viewer.applyLayerTransforms();
        viewer.draw();
        return true;      // not a pan: the board holds still, the photo moves
      }
      if (api.draw) {
        api.draw.now = pos;
        api.draw.moved = api.draw.moved || !!drag.moved;
        viewer.draw();
        return true;      // not a pan: the board must hold still under the box
      }
      if (!api.drag) return false;
      var now = viewer.screenToSpace(pos[0], pos[1]);
      var dx = now[0] - api.drag.start[0];
      var dy = now[1] - api.drag.start[1];
      var g = geometryOf(api.drag.ref, viewer.space, api.drag.occurrence);
      if (!g) return true;
      // Snapshot on the first movement rather than on press, so selecting a
      // marker without moving it does not fill the history with no-ops.
      if (!api.drag.snapped) {
        api.drag.snapped = true;
        pushUndo(itemEntry(BE.lookup(api.drag.ref),
          (api.drag.mode === 'resize' ? 'resize ' : 'move ') + api.drag.ref));
      }
      if (api.drag.mode === 'move') {
        g.x = api.drag.origin.x + dx;
        g.y = api.drag.origin.y + dy;
      } else if (api.drag.handle) {
        resizeToEdge(g, api.drag.origin, api.drag.handle, now);
      } else {
        // Alt+drag, which sizes about the centre rather than an edge.
        g.w = (api.drag.origin.w || DEFAULT_SIZE.w) + dx * 2;
        g.h = (api.drag.origin.h || DEFAULT_SIZE.h) + dy * 2;
      }
      clampGeometry(g);
      if (viewer.space !== 'board') g.zone = zoneFor(viewer.space, g.x, g.y);
      // The viewer draws from its own copy of the coordinates, so the edit has
      // to reach that copy or nothing moves until the next full refresh --
      // which is what dragging blind felt like.
      syncViewerItem(viewer, api.drag.ref, api.drag.occurrence, g);
      viewer.draw();
      return true;
    },

    onPointerUp: function (e, drag, viewer) {
      if (outlineDrag) {
        var moved = outlineDrag.snapped;
        outlineDrag = null;
        if (moved) commit();
        viewer.draw();
        return;
      }
      if (api.draw) {
        // The viewer routes pointercancel here too, and a cancelled gesture is
        // not a short one: the browser took the pointer away mid-sweep -- a
        // palm on a bench tablet, the window losing focus -- and the event
        // carries no meaningful position to finish with. Placing a marker from
        // it would invent a box nobody drew and mark it checked by hand.
        if (e && e.type === 'pointercancel') { cancelDraw(true); return; }
        finishDraw(viewer, e, drag);
        return;
      }
      if (api.drag) {
        // A marker someone dragged into place was placed by hand, whatever the
        // OCR pass thought -- the provenance pill has to say so.
        if (api.drag.snapped) markHandPlaced(BE.lookup(api.drag.ref), api.drag.space);
        api.drag = null;
        commit();
      }
    },

    consumeClick: function () {
      return false;
    },

    /** What a press at this point would do, shown as the pointer. */
    cursorFor: function (pos, hit, dflt, viewer) {
      if (!BE.state.author || landmarkMode) return dflt;
      if (outlineDrag) return 'grabbing';
      if (outlineMode) return outlineHandleAt(viewer, pos) >= 0 ? 'grab' : dflt;
      if (armedRef || api.draw) return 'crosshair';
      if (api.drag) return api.drag.handle ? CURSORS[api.drag.handle]
                                           : (api.drag.mode === 'resize' ? 'nwse-resize' : 'grabbing');
      var handle = handleAt(viewer, pos);
      if (handle) return CURSORS[handle];
      if (hit && isSelected(hit.ref)) return 'move';
      var sel = grabTarget(viewer, pos, hit);
      if (sel && isSelected(sel.ref)) return 'move';
      return dflt;
    },

    afterDraw: function (ctx, viewer) {
      if (!BE.state.author) return;
      drawHandles(ctx, viewer);
      if (outlineMode) drawOutline(ctx, viewer);
      if (landmarkMode || pendingLandmark) drawLandmarks(ctx, viewer);
      if (api.draw) drawSweep(ctx, viewer);
      if (armedRef) {
        ctx.save();
        ctx.font = '600 12px ui-monospace, Menlo, monospace';
        ctx.fillStyle = '#f2b035';
        ctx.fillText(armPrompt(), 14, 22);
        ctx.restore();
      }
    },

    renderInspector: function (panelBody) {
      if (!BE.state.author) return;
      var wrap = document.createElement('div');
      wrap.innerHTML = inspectorHTML();
      panelBody.appendChild(wrap);
      bindInspector(wrap);
    }
  };

  /* ---- geometry helpers ---- */

  function isSelected(ref) { return BE.state.selected === ref; }

  /**
   * Keep a box inside the drawing -- the whole box, not just its centre.
   *
   * Nothing exists outside the drawing, so no part of a marker belongs out
   * there: a box half over the edge is half unclickable, and one dragged clear
   * of it cannot be clicked at all. Positions are held in normalised space, so
   * the drawing is exactly 0..1 in both axes and the box spans w and h about
   * its centre.
   */
  function clampGeometry(g) {
    if (!g) return g;
    if (g.w != null) g.w = Math.min(1, Math.max(MIN_SIZE, g.w));
    if (g.h != null) g.h = Math.min(1, Math.max(MIN_SIZE, g.h));
    g.x = clampSpan(g.x, (g.w || 0) / 2);
    g.y = clampSpan(g.y, (g.h || 0) / 2);
    return g;
  }

  /** Centre held so a box of half-width `half` stays within 0..1. */
  function clampSpan(v, half) {
    if (v == null || isNaN(v)) return half;
    if (half * 2 >= 1) return 0.5;          // as wide as the board: centre it
    return Math.min(1 - half, Math.max(half, v));
  }

  /**
   * Which marker a press should grab.
   *
   * Hit testing hands back the smallest box under the cursor, which is right
   * for selecting but wrong for dragging: TP201's pad sits inside P901's
   * outline, so a press there always lands on the connector and the test point
   * cannot be moved at all. Once something is selected, a press inside it
   * grabs it -- picking a part from the search results or a list is then
   * enough to make it draggable, whatever is drawn on top.
   */
  function grabTarget(viewer, pos, hit) {
    var sel = BE.state.selected;
    if (!sel || (hit && hit.ref === sel)) return hit;
    var g = geometryOf(sel, viewer.space);
    if (!g) return hit;
    var box = viewer.screenBox({ x: g.x, y: g.y, w: g.w, h: g.h });
    var inside = pos[0] >= box.x && pos[0] <= box.x + box.w &&
                 pos[1] >= box.y && pos[1] <= box.y + box.h;
    return inside ? { ref: sel } : hit;
  }

  function geometryOf(ref, space, occurrence) {
    var item = BE.lookup(ref);
    if (!item) return null;
    if (space === 'board') return item.board;
    var list = item.sch || [];
    if (occurrence != null && list[occurrence] &&
        list[occurrence].sheet === space) return list[occurrence];
    return list.find(function (s) { return s.sheet === space; });
  }

  /**
   * Remember which occurrence a press chose. A press that carries none keeps
   * the previous choice only while it is still about the same part -- the
   * synthesised grab of the current selection says nothing about occurrences.
   */
  function noteHit(hit) {
    if (!hit) return;
    if (hit.occurrence != null) selOcc = { ref: hit.ref, occurrence: hit.occurrence };
    else if (!(selOcc && selOcc.ref === hit.ref)) selOcc = null;
  }

  /** The pointer-chosen occurrence of the current selection, if still valid. */
  function selectedOccurrence() {
    return selOcc && selOcc.ref === BE.state.selected ? selOcc.occurrence : null;
  }

  /**
   * Give an item a position in the space on screen.
   *
   * Both ways of placing something end up here -- the click that drops a
   * default box and the outline swept out by hand -- so the provenance, the
   * grid zone, the fence around the drawing and the undo entry are decided
   * once. They used to be decided in the one function that could place
   * anything, and a second one would have been a second set of rules.
   */
  function placeGeometry(viewer, ref, g, label) {
    var item = BE.lookup(ref);
    if (!item) return;
    pushUndo(itemEntry(item, (label || 'place') + ' ' + ref));
    if (viewer.space === 'board') {
      item.board = clampGeometry(g);
    } else {
      item.sch = item.sch || [];
      g.sheet = viewer.space;
      clampGeometry(g);
      g.zone = zoneFor(viewer.space, g.x, g.y);
      item.sch.push(g);
      // The symbol just drawn is the one the next keystroke should act on.
      selOcc = { ref: ref, occurrence: item.sch.length - 1 };
    }
    markHandPlaced(item, viewer.space);
    BE.set({ selected: ref });
  }

  /**
   * A click with no drag still places a default-size box, the way it always
   * has: someone who only wants to say roughly where a part is should not have
   * to sweep an outline they will immediately correct.
   *
   * Board space is normalised 0..1 on both axes over a board that is not
   * square, so a round marker is stored with h = w / aspect. Give a circle the
   * default box's proportions and it comes out an egg.
   */
  function placeAt(viewer, ref, pos, shape) {
    var item = BE.lookup(ref);
    if (!item) return;
    var p = viewer.screenToSpace(pos[0], pos[1]);
    var dflt = item.isTestPoint ? { w: 0.009, h: 0.011 } : DEFAULT_SIZE;
    // Re-placing something on the board keeps the size it already had; on a
    // sheet this adds an occurrence, which has no size of its own yet.
    var existing = viewer.space === 'board' ? item.board : null;
    var s = shape || (existing && existing.shape) || (item.isTestPoint ? 'point' : 'rect');
    var g = { x: p[0], y: p[1], shape: s,
              w: (existing && existing.w) || dflt.w,
              h: (existing && existing.h) || dflt.h };
    if (s !== 'rect' && !(existing && existing.shape === s)) g.h = g.w / viewer.aspect;
    placeGeometry(viewer, ref, g);
  }

  /* ---- drawing an outline from scratch ----
   *
   * Sizing a marker used to mean dropping a fixed box and then dragging four
   * edges onto the part, and the handles do not even appear until the box is
   * 24 px across, so a small part had to be zoomed in on before it could be
   * sized at all. Sweeping the outline is one gesture instead of five.
   *
   * The two shapes are swept differently, and the reason is what the drawing
   * gives you to aim at. A rectangular part shows its own corners, so a box is
   * drawn corner to corner. A round part shows only its rim -- nothing marks
   * the centre of a can -- so a circle is drawn rim to rim across the middle,
   * the drag being a diameter rather than the diagonal of a bounding box.
   * Taking those same two rim points as box corners would put them at √2 times
   * the radius and draw a circle about 30% too small.
   */

  /** The swept shape in screen pixels: {cx, cy, w, h}. */
  function sweepScreen(d) {
    var dx = d.now[0] - d.start[0];
    var dy = d.now[1] - d.start[1];
    if (d.shape === 'rect') {
      if (d.square) {
        var m = Math.max(Math.abs(dx), Math.abs(dy));
        dx = dx < 0 ? -m : m;
        dy = dy < 0 ? -m : m;
      }
      return d.fromCentre
        ? { cx: d.start[0], cy: d.start[1], w: Math.abs(dx) * 2, h: Math.abs(dy) * 2 }
        : { cx: d.start[0] + dx / 2, cy: d.start[1] + dy / 2,
            w: Math.abs(dx), h: Math.abs(dy) };
    }
    // Round shapes are measured in screen pixels and kept equal in both axes,
    // which is what makes them round on screen -- and square in the pixels of
    // the drawing, which is how the overrides file records them.
    var len = Math.sqrt(dx * dx + dy * dy);
    var diameter = d.fromCentre ? len * 2 : len;
    return d.fromCentre
      ? { cx: d.start[0], cy: d.start[1], w: diameter, h: diameter }
      : { cx: d.start[0] + dx / 2, cy: d.start[1] + dy / 2, w: diameter, h: diameter };
  }

  /** The same shape in the coordinates the dataset stores. */
  function sweepGeometry(viewer, d) {
    var s = sweepScreen(d);
    var c = viewer.screenToSpace(s.cx, s.cy);
    return { x: c[0], y: c[1], shape: d.shape,
             w: s.w / viewer.scale,
             h: s.h / viewer.scale / viewer.aspect };
  }

  function finishDraw(viewer, e, drag) {
    var d = api.draw;
    api.draw = null;
    armedRef = null;
    if (!viewer || !d) return;
    if (e) d.now = viewer.eventPos(e);
    // The viewer already decides what counts as a drag rather than a click,
    // and it is the same threshold the pan uses; a second one here would let
    // a gesture be a drag for one and a click for the other.
    var swept = !!(d.moved || (drag && drag.moved));
    if (swept) {
      var g = sweepGeometry(viewer, d);
      var note = snapToOutline(viewer, g);
      placeGeometry(viewer, d.ref, g, 'draw');
      if (note) host.toast(d.ref + ' ' + note);
    } else {
      // A default box dropped by a click has no relationship to the part under
      // it, so there is nothing for a fit to correct towards.
      placeAt(viewer, d.ref, d.now, d.shape);
    }
    commit();
  }

  /**
   * Pull a swept shape onto the outline printed under it, if snapping is on
   * and the drawing supports it. Edits `g` in place; returns what to say.
   */
  function snapToOutline(viewer, g) {
    if (!snapOn || !global.Snap) return null;
    var why = global.Snap.unavailable(viewer);
    if (why) return warnOnce(why);

    var fit = global.Snap.refine(viewer, g);
    // Whether the page can be read at all is only discovered by trying: a
    // canvas fed a file:// image throws on the way out of the first attempt.
    // Asking again afterwards is what turns that first silent failure into the
    // explanation the second one would have given.
    why = global.Snap.unavailable(viewer);
    if (why) return warnOnce(why);

    if (!fit) {
      // Silence here reads as "snapping did nothing" and leaves no way to tell
      // it from "snapping is off". Say which.
      host.toast('Kept as drawn — no outline within ' +
        Math.round(global.Snap.TOLERANCE * 100) + '% of it');
      return null;
    }
    Object.assign(g, fit.geom);
    return fit.note;
  }

  /** Explain why snapping is off, the first time it matters. */
  function warnOnce(why) {
    if (!snapWarned) { snapWarned = true; host.toast('Not snapping: ' + why); }
    return null;
  }

  function cancelDraw(quiet) {
    if (!armedRef && !api.draw) return false;
    armedRef = null;
    api.draw = null;
    if (!quiet) host.toast('Placement cancelled');
    var viewer = global.App.viewer();
    if (viewer) viewer.draw();
    host.refresh();
    return true;
  }

  function armPrompt() {
    var tool = DRAW_TOOLS.find(function (t) { return t.id === drawShape; }) || DRAW_TOOLS[0];
    return 'Draw ' + armedRef + ' — ' +
      (drawShape === 'rect' ? 'drag corner to corner'
                            : 'drag across the middle, rim to rim') +
      ', or click for a default ' + tool.label.toLowerCase() + ' · Esc cancels';
  }

  function drawSweep(ctx, viewer) {
    var d = api.draw;
    var s = sweepScreen(d);
    if (s.w < 1 && s.h < 1) return;      // still a click, nothing to show yet
    var box = { x: s.cx - s.w / 2, y: s.cy - s.h / 2, w: s.w, h: s.h,
                cx: s.cx, cy: s.cy };
    ctx.save();
    ctx.strokeStyle = '#f2b035';
    // The drag itself, drawn under the outline: on a circle it is the diameter
    // you swept, and seeing it lets you tell "across the middle" from a chord
    // before you let go, which is the one way this gesture goes wrong.
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(d.start[0], d.start[1]);
    ctx.lineTo(d.now[0], d.now[1]);
    ctx.stroke();

    ctx.globalAlpha = 1;
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 4]);
    viewer.pathShape(ctx, d.shape, box, 0);
    ctx.stroke();
    ctx.setLineDash([]);

    // Sizes in the units the coords file and the inspector both use, so a
    // shape can be read off the screen and typed back in.
    var g = sweepGeometry(viewer, d);
    var text = d.shape === 'rect'
      ? fmt(g.w) + ' × ' + fmt(g.h)
      : 'Ø ' + fmt(g.w);
    ctx.font = '600 11px ui-monospace, SFMono-Regular, Menlo, monospace';
    var tw = ctx.measureText(text).width;
    // Beside the pointer rather than beside the box: your eye is already at the
    // pointer, and a corner of the box is where the info card sits.
    var lx = Math.min(viewer.width - tw - 10, Math.max(6, d.now[0] + 16));
    var ly = Math.min(viewer.height - 6, Math.max(14, d.now[1] + 24));
    ctx.fillStyle = 'rgba(16,18,22,0.86)';
    ctx.fillRect(lx - 4, ly - 11, tw + 8, 15);
    ctx.fillStyle = '#f2b035';
    ctx.fillText(text, lx, ly);
    ctx.restore();
  }

  function fmt(v) { return (v == null ? 0 : v).toFixed(4); }

  /** Which space the main viewer is showing, before it exists at startup. */
  function currentSpace() {
    var viewer = global.App && global.App.viewer && global.App.viewer();
    return viewer ? viewer.space : 'board';
  }

  function trackModifiers(e) {
    if (!api.draw) return;
    api.draw.square = !!e.shiftKey;
    api.draw.fromCentre = !!e.altKey;
    var viewer = global.App.viewer();
    if (viewer) viewer.draw();
  }

  /**
   * The printed grid zone a sheet position falls in, e.g. 'C6'.
   *
   * Mirrors zone_for() in tools/assemble.py, which stamps zones at build time.
   * Deriving it here too means a part placed now reads "sh1 / C6" straight
   * away rather than a bare sheet name until the next rebuild -- and being
   * able to say "C23 is at C6" out loud is the entire point of the zones.
   */
  function zoneFor(sheetId, x, y, dataset) {
    // Restoring saved edits happens per registered dataset, which is not
    // necessarily the one on screen, so the dataset can be named explicitly.
    var d = dataset || BE.state.assembly;
    if (!d) return null;
    var sheet = (d.schematics || []).find(function (s) { return s.id === sheetId; });
    var grid = sheet && sheet.grid;
    if (!grid || !grid.frame || !grid.cols || !grid.rows) return null;
    var fx = (x - grid.frame.x0) / (grid.frame.x1 - grid.frame.x0);
    var fy = (y - grid.frame.y0) / (grid.frame.y1 - grid.frame.y0);
    if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return null;
    var col = grid.cols[Math.min(grid.cols.length - 1,
      Math.max(0, Math.floor(fx * grid.cols.length)))];
    var row = grid.rows[Math.min(grid.rows.length - 1,
      Math.max(0, Math.floor(fy * grid.rows.length)))];
    return row + col;
  }

  function markHandPlaced(item, space) {
    if (!item) return;
    if (space === 'board') {
      item.verified = true;
      item.placement = 'verified';
      delete item.placementNote;
    } else {
      item.schVerified = true;
    }
  }

  function onKeyDown(e) {
    if (!BE.state.author) return;
    trackModifiers(e);
    // Inside a text field the browser's own undo is the right one.
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) return;

    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) redo(); else undo();
      return;
    }

    // Escape leaves outline alignment the way it leaves every other mode here.
    // The fit itself stays: it was solved and committed on each drag, so this
    // puts the tool away rather than undoing the work.
    if (outlineMode && e.key === 'Escape' && !armedRef && !api.draw) {
      e.preventDefault();
      setOutlineMode(false);
      host.refresh();
      return;
    }

    // Armed and pointing at the part is the moment you notice it is round, so
    // the tool can be switched without going back to the panel for it.
    if (armedRef || api.draw) {
      if (e.key === 'Escape') { e.preventDefault(); cancelDraw(); return; }
      var tool = DRAW_TOOLS.find(function (t) { return t.key === e.key.toLowerCase(); });
      if (tool && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        drawShape = tool.id;
        if (api.draw) api.draw.shape = tool.id;
        var v = global.App.viewer();
        if (v) v.draw();
        host.refresh();
        return;
      }
    }

    if (!BE.state.selected) return;

    // Delete throws away the box and hands you the pencil. Nudging a bad
    // outline into a good one is the slow way round when the shape itself is
    // wrong -- a label box where a component body belongs, say -- and starting
    // from nothing is one gesture. On a Mac the key marked Delete sends
    // Backspace, so both mean the same thing here.
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      clearAndRedraw(global.App.viewer(), BE.lookup(BE.state.selected));
      return;
    }

    var step = e.shiftKey ? 0.01 : 0.001;
    var deltas = { ArrowLeft: [-step, 0], ArrowRight: [step, 0],
                   ArrowUp: [0, -step], ArrowDown: [0, step] };
    var d = deltas[e.key];
    if (!d) return;
    e.preventDefault();
    var viewer = global.App.viewer();
    var item = BE.lookup(BE.state.selected);
    var g = geometryOf(BE.state.selected, viewer.space, selectedOccurrence());
    if (!g) return;
    pushUndo(itemEntry(item, 'nudge ' + item.ref, 'nudge'));
    g.x += d[0];
    g.y += d[1];
    clampGeometry(g);
    if (viewer.space !== 'board') g.zone = zoneFor(viewer.space, g.x, g.y);
    markHandPlaced(item, viewer.space);
    commit();
  }

  /* ---- resize handles ---- */

  var HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
  var CORNERS = ['nw', 'ne', 'se', 'sw'];
  var HANDLE_R = 4;           // drawn half-size
  var GRAB_R = 7;             // how close the pointer has to be
  var EDGES_FROM = 30;        // below this, corners only -- edge handles would
                              // land on top of each other
  var HANDLES_FROM = 24;      // below this the handles would cover the marker
                              // entirely and every press would resize what you
                              // meant to move; zoom in to size a small part

  var CURSORS = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize',
                  sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize',
                  e: 'ew-resize', w: 'ew-resize' };

  /**
   * The viewer's entry for the current selection, in the space on screen --
   * the pointer-chosen occurrence when there is one, since the handles have
   * to sit on the symbol that was clicked, not on its first sibling.
   */
  function selectedEntry(viewer) {
    var sel = BE.state.selected;
    if (!sel || !viewer || !viewer.items) return null;
    var want = selectedOccurrence();
    var first = null;
    for (var i = 0; i < viewer.items.length; i++) {
      var it = viewer.items[i];
      if (it.ref !== sel) continue;
      if (want != null && it.occurrence === want) return it;
      if (!first) first = it;
    }
    return first;
  }

  /** Handle positions in screen space, or [] when nothing is selected. */
  function handlePoints(viewer) {
    var entry = selectedEntry(viewer);
    if (!entry || !BE.state.author || landmarkMode || armedRef) return [];
    var box = viewer.screenBox(entry);
    if (box.w < HANDLES_FROM || box.h < HANDLES_FROM) return [];
    var ids = (box.w < EDGES_FROM || box.h < EDGES_FROM) ? CORNERS : HANDLES;
    return ids.map(function (id) {
      return {
        id: id,
        x: id.indexOf('w') >= 0 ? box.x : (id.indexOf('e') >= 0 ? box.x + box.w : box.cx),
        y: id.indexOf('n') >= 0 ? box.y : (id.indexOf('s') >= 0 ? box.y + box.h : box.cy)
      };
    });
  }

  function handleAt(viewer, pos) {
    var found = null;
    handlePoints(viewer).forEach(function (h) {
      if (found) return;
      if (Math.abs(pos[0] - h.x) <= GRAB_R && Math.abs(pos[1] - h.y) <= GRAB_R) found = h.id;
    });
    return found;
  }

  function drawHandles(ctx, viewer) {
    var points = handlePoints(viewer);
    if (!points.length) return;
    ctx.save();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(12,15,20,0.9)';
    ctx.fillStyle = '#ff7a45';
    points.forEach(function (h) {
      ctx.beginPath();
      ctx.rect(h.x - HANDLE_R, h.y - HANDLE_R, HANDLE_R * 2, HANDLE_R * 2);
      ctx.fill();
      ctx.stroke();
    });
    ctx.restore();
  }

  /**
   * Resize by moving one edge, or two at a corner, leaving the opposite edge
   * where it is -- the way a box behaves everywhere else. The centre and size
   * are what get stored, so the edges are derived, moved and folded back.
   */
  function resizeToEdge(g, origin, handle, now) {
    var left = origin.x - (origin.w || DEFAULT_SIZE.w) / 2;
    var right = origin.x + (origin.w || DEFAULT_SIZE.w) / 2;
    var top = origin.y - (origin.h || DEFAULT_SIZE.h) / 2;
    var bottom = origin.y + (origin.h || DEFAULT_SIZE.h) / 2;

    if (handle.indexOf('w') >= 0) left = Math.min(now[0], right - MIN_SIZE);
    if (handle.indexOf('e') >= 0) right = Math.max(now[0], left + MIN_SIZE);
    if (handle.indexOf('n') >= 0) top = Math.min(now[1], bottom - MIN_SIZE);
    if (handle.indexOf('s') >= 0) bottom = Math.max(now[1], top + MIN_SIZE);

    g.x = (left + right) / 2;
    g.y = (top + bottom) / 2;
    g.w = right - left;
    g.h = bottom - top;
  }

  /** Push an in-progress edit into the viewer's copy so the screen keeps up. */
  function syncViewerItem(viewer, ref, occurrence, g) {
    for (var i = 0; i < viewer.items.length; i++) {
      var it = viewer.items[i];
      if (it.ref !== ref) continue;
      if (occurrence != null && it.occurrence !== occurrence) continue;
      it.x = g.x; it.y = g.y; it.w = g.w; it.h = g.h;
      return;
    }
  }

  /* ---- undo ----
   *
   * An entry holds the object that changed and a copy of it as it was. The
   * object itself is the identity, not its designator, so undoing a rename
   * works like any other edit. Applying an entry returns its inverse, which is
   * what makes undo and redo the same operation run in opposite directions.
   */

  function clone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }

  function itemEntry(item, label, tag) {
    return { kind: 'item', target: item, data: clone(item), label: label, tag: tag };
  }

  function layerEntry(layer, label, tag) {
    return { kind: 'layer', target: layer, label: label, tag: tag,
             data: { transform: clone(layer.transform), landmarks: clone(layer.landmarks) } };
  }

  function pushUndo(entry) {
    if (!entry || !entry.target) return;
    // A run of arrow-key nudges collapses into one step, the way a run of
    // typing does in a text editor: walking a marker into place should not
    // cost twenty presses of undo to walk back out of.
    var top = undoStack[undoStack.length - 1];
    if (entry.tag && top && top.tag === entry.tag && top.target === entry.target) return;
    undoStack.push(entry);
    if (undoStack.length > UNDO_LIMIT) undoStack.shift();
    redoStack.length = 0;
  }

  function applyEntry(entry) {
    var inverse;
    if (entry.kind === 'item') {
      var item = entry.target;
      inverse = itemEntry(item, entry.label, entry.tag);
      Object.keys(item).forEach(function (k) { delete item[k]; });
      Object.assign(item, clone(entry.data));
      reindex();
      // The restore may have reshaped item.sch, so a remembered index into it
      // no longer names the same symbol.
      selOcc = null;
      BE.set({ selected: item.ref });
    } else {
      var layer = entry.target;
      inverse = layerEntry(layer, entry.label, entry.tag);
      layer.transform = clone(entry.data.transform);
      layer.landmarks = clone(entry.data.landmarks);
    }
    return inverse;
  }

  /** Rebuild the designator index, which a rename or its undo invalidates. */
  function reindex() {
    var d = BE.state.assembly;
    if (!d) return;
    d.byRef = {};
    BE.items(d).forEach(function (i) { d.byRef[i.ref] = i; });
  }

  function undo() {
    var entry = undoStack.pop();
    if (!entry) { host.toast('Nothing to undo'); return; }
    redoStack.push(applyEntry(entry));
    commit();
    host.toast('Undid ' + entry.label);
  }

  function redo() {
    var entry = redoStack.pop();
    if (!entry) { host.toast('Nothing to redo'); return; }
    undoStack.push(applyEntry(entry));   // not pushUndo: that would drop the
                                         // rest of the redo stack
    commit();
    host.toast('Redid ' + entry.label);
  }

  /* ---- back to the file ---- */

  function baselineFor(ref) {
    var d = BE.state.assembly;
    var base = d ? baselines[d.id] : null;
    return base && base.placement ? base.placement[ref] : null;
  }

  /** Put one item back where the data file has it, leaving other edits alone. */
  function revertItem(item) {
    var base = baselineFor(item.ref);
    if (!base) { host.toast('No shipped position for ' + item.ref); return; }
    pushUndo(itemEntry(item, 'restore ' + item.ref));
    if (base.board) item.board = clone(base.board); else delete item.board;
    if (base.sch) item.sch = clone(base.sch); else delete item.sch;
    item.verified = !!base.verified;
    item.schVerified = !!base.schVerified;
    if (base.placement) item.placement = base.placement;
    commit();
    host.toast(item.ref + ' restored to its position in the data file');
  }

  /** Markers dragged clear off the board, which there is no way left to click. */
  function offBoard(items) {
    return items.filter(function (i) {
      var g = i.board;
      return g && (g.x < -OFF_BOARD || g.x > 1 + OFF_BOARD ||
                   g.y < -OFF_BOARD || g.y > 1 + OFF_BOARD);
    });
  }

  /* ---- what is missing, in the space you are looking at ---- */

  /**
   * The editor's idea of "unplaced" has to follow the view. On the board that
   * means a part with no board position; on a sheet it means a part drawn
   * nowhere on the schematic -- and those are different lists. Showing the
   * board's list while a sheet is on screen offers parts that are already
   * placed here and hides the ones that are not, which is the only list that
   * can be acted on from this view.
   */
  function missingIn(items, space) {
    return items.filter(function (i) {
      if (i.notOnDrawing) return false;   // no silkscreen, and no symbol either
      if (space === 'board') return !i.board;
      // A rubber foot and a heat sink carry no schematic symbol, so listing
      // them as missing from the sheets would never empty. One that does turn
      // out to be drawn can still be placed: find it, then "Add on this sheet".
      if (i.kind === 'mech') return false;
      return !(i.sch && i.sch.length);
    });
  }

  function spaceLabel(space) {
    if (space === 'board') return 'the board';
    var d = BE.state.assembly;
    var sheet = (d.schematics || []).find(function (s) { return s.id === space; });
    return sheet ? (sheet.title || sheet.id) : 'the schematic';
  }

  /* ---- landmarks and the photo homography ---- */

  function landmarkStore() {
    var d = BE.state.assembly;
    var photo = (d.layers || []).find(function (l) { return l.id === 'photo'; });
    if (!photo) return null;
    photo.landmarks = photo.landmarks || [];
    return photo;
  }

  function addLandmarkPoint(viewer, pos) {
    var photo = landmarkStore();
    if (!photo) return;
    var p = viewer.screenToSpace(pos[0], pos[1]);
    if (!pendingLandmark) {
      // First click is the point in board space, taken on the drawing.
      pendingLandmark = { src: [p[0], p[1]] };
      host.toast('Board point set — switch to Photo and click the same feature');
    } else {
      // Second click is the same feature seen on the photo. The viewer is
      // showing the photo warped by the current (possibly wrong) homography,
      // so the click has to be pushed back through it to reach photo space.
      var H = photo.transform && photo.transform.H;
      var dst = H ? Geom.apply(H, p[0], p[1]) : [p[0], p[1]];
      pushUndo(layerEntry(photo, 'landmark ' + (photo.landmarks.length + 1)));
      photo.landmarks.push({ src: pendingLandmark.src, dst: dst });
      pendingLandmark = null;
      solveLandmarks();
      host.toast(photo.landmarks.length + ' landmark(s) — ' +
        (photo.landmarks.length < 4 ? 'need at least 4' : 'alignment updated'));
    }
    commit();
  }

  function solveLandmarks() {
    var photo = landmarkStore();
    if (!photo || photo.landmarks.length < 4) return;
    var H = Geom.solveHomography(photo.landmarks);
    if (!H) { host.toast('Those landmarks do not resolve — check for duplicates'); return; }
    photo.transform = { H: H };
  }

  /* ---- outline alignment ---- */

  /**
   * The photograph's four corners, expressed as landmark pairs.
   *
   * dst is the corner in photo space and never moves; src is where that corner
   * currently falls on the board, which is what the handles show and what a
   * drag rewrites. Seeded through the inverse of the current H so opening the
   * mode on an already-aligned board shows the fit it has rather than jumping.
   */
  function seedOutline() {
    var photo = landmarkStore();
    if (!photo) return null;
    var H = photo.transform && photo.transform.H;
    var inv = H ? Geom.invert(H) : null;
    return PHOTO_CORNERS.map(function (c) {
      var s = inv ? Geom.apply(inv, c.at[0], c.at[1]) : [c.at[0], c.at[1]];
      return { note: c.note, src: [s[0], s[1]], dst: [c.at[0], c.at[1]] };
    });
  }

  function outlineHandleAt(viewer, pos) {
    if (!outlineQuad || viewer.space !== 'board') return -1;
    for (var i = 0; i < outlineQuad.length; i++) {
      var s = viewer.spaceToScreen(outlineQuad[i].src[0], outlineQuad[i].src[1]);
      if (Math.abs(s[0] - pos[0]) <= OUTLINE_GRAB &&
          Math.abs(s[1] - pos[1]) <= OUTLINE_GRAB) return i;
    }
    return -1;
  }

  /** Re-solve from the quad and push it into the live layer, mid-drag. */
  function applyOutline() {
    var photo = landmarkStore();
    if (!photo || !outlineQuad) return;
    var H = Geom.solveHomography(outlineQuad);
    // Dragging a corner across one of its neighbours folds the quad and the
    // solve degenerates. Keeping the last good H rather than clearing it means
    // the photo stops following instead of vanishing, and dragging back out
    // recovers -- which is what makes a bow-tie feel like a mistake you can
    // undo by moving, not an error you have to dismiss.
    if (!H) return;
    photo.landmarks = outlineQuad.map(function (p) {
      return { note: p.note, src: [p.src[0], p.src[1]], dst: [p.dst[0], p.dst[1]] };
    });
    photo.transform = { H: H };
  }

  function drawOutline(ctx, viewer) {
    if (!outlineQuad || viewer.space !== 'board') return;
    var pts = outlineQuad.map(function (p) {
      return viewer.spaceToScreen(p.src[0], p.src[1]);
    });
    ctx.save();
    // The quad is the photograph's own border, so it reads as the edge of the
    // picture being moved rather than as anything printed on the board.
    ctx.strokeStyle = '#4ec9d6';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([7, 4]);
    ctx.beginPath();
    pts.forEach(function (p, i) { i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]); });
    ctx.closePath();
    ctx.stroke();
    ctx.setLineDash([]);
    pts.forEach(function (p, i) {
      var live = outlineDrag && outlineDrag.i === i;
      ctx.beginPath();
      ctx.arc(p[0], p[1], live ? 9 : 7, 0, Math.PI * 2);
      ctx.fillStyle = live ? '#4ec9d6' : 'rgba(14,20,28,0.85)';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#4ec9d6';
      ctx.stroke();
    });
    ctx.restore();
  }

  function setOutlineMode(on) {
    outlineMode = !!on;
    outlineQuad = outlineMode ? seedOutline() : null;
    outlineDrag = null;
    if (outlineMode) {
      landmarkMode = false;
      pendingLandmark = null;
      var photo = landmarkStore();
      // A board with no alignment yet has Photo, Overlay and Swipe disabled --
      // correctly, since the app will not show a picture it cannot line up.
      // But that is exactly the board this tool is for, and it left nothing on
      // screen to drag against. So seed the identity fit: the photo appears
      // stretched corner to corner over the board, visibly wrong and ready to
      // be dragged right. It is a real edit, so it goes on the undo stack.
      if (photo && !(photo.transform && photo.transform.H)) {
        pushUndo(layerEntry(photo, 'start outline alignment'));
        applyOutline();
        commit();
      }
      // The mode is about watching the photo move, so put it on screen. The
      // set is a no-op when the display is already one of the three, and a
      // no-op emits nothing -- so the Photo/Overlay/Swipe buttons, which are
      // disabled until the layer has a transform, would stay greyed out on the
      // very board that just gained one. Refresh regardless of the diff.
      if (['photo', 'overlay', 'swipe'].indexOf(BE.state.display) < 0) {
        BE.set({ display: 'overlay' });
      }
      if (host.redisplay) host.redisplay();
      host.refresh();
      host.toast('Drag the photo’s corners until the board edge lines up');
    }
  }

  function drawLandmarks(ctx, viewer) {
    var photo = landmarkStore();
    if (!photo || viewer.space !== 'board') return;
    ctx.save();
    ctx.strokeStyle = '#f2b035';
    ctx.fillStyle = '#f2b035';
    (photo.landmarks || []).forEach(function (lm, i) {
      var s = viewer.spaceToScreen(lm.src[0], lm.src[1]);
      ctx.beginPath();
      ctx.moveTo(s[0] - 8, s[1]); ctx.lineTo(s[0] + 8, s[1]);
      ctx.moveTo(s[0], s[1] - 8); ctx.lineTo(s[0], s[1] + 8);
      ctx.stroke();
      ctx.font = '10px ui-monospace, Menlo, monospace';
      ctx.fillText(String(i + 1), s[0] + 10, s[1] - 4);
    });
    if (pendingLandmark) {
      var p = viewer.spaceToScreen(pendingLandmark.src[0], pendingLandmark.src[1]);
      ctx.strokeStyle = '#4ec9d6';
      ctx.beginPath();
      ctx.arc(p[0], p[1], 9, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  /* ---- inspector ---- */

  function inspectorHTML() {
    var d = BE.state.assembly;
    var item = BE.state.selected ? BE.lookup(BE.state.selected) : null;
    var all = BE.items(d);
    var space = global.App.viewer().space;
    var onBoard = space === 'board';
    // Parts with no silkscreen designator are not "missing" -- there is
    // nothing on the drawing to point at -- so offering them here would send
    // someone hunting for a washer that was never drawn.
    var unplaced = missingIn(all, space);
    var html = '';

    html += '<section class="panel-section"><header><span class="author-flag">Author</span>' +
      '<span class="spacer"></span><span class="count">' +
      (dirty ? 'unsaved edits' : 'no edits') + '</span></header>';

    var lastUndo = undoStack[undoStack.length - 1];
    var lastRedo = redoStack[redoStack.length - 1];
    html += '<div class="btn-row">' +
      '<button class="btn" data-author="undo"' + (lastUndo ? '' : ' disabled') +
      ' title="Cmd/Ctrl+Z">Undo' +
      (lastUndo ? ' ' + global.App.esc(lastUndo.label) : '') + '</button>' +
      '<button class="btn" data-author="redo"' + (lastRedo ? '' : ' disabled') +
      ' title="Cmd/Ctrl+Shift+Z">Redo' +
      (lastRedo ? ' ' + global.App.esc(lastRedo.label) : '') + '</button></div>';

    html += '<div class="btn-row">' +
      '<button class="btn" data-author="export-coords">Export coordinates</button>' +
      '<button class="btn" data-author="export-data">Export data file</button>' +
      '<button class="btn danger" data-author="revert">Discard edits</button></div>';

    // Every edited board in one file. Doing the two buttons above by hand for
    // seventeen assemblies is thirty-four downloads and thirty-four Save As
    // dialogs, which is enough friction that a round of edits gets exported
    // board by board over days -- or not at all.
    var pending = editedAssemblies();
    html += '<div class="btn-row">' +
      '<button class="btn" data-author="export-all"' +
      (pending.length ? '' : ' disabled') + '>Export all boards' +
      (pending.length ? ' (' + pending.length + ')' : '') + '</button>' +
      '<button class="btn" data-author="export-all-force" ' +
      'title="Every board, edited or not">Export all, including unedited</button></div>';
    if (pending.length) {
      // 12px in, like every other label in this panel and like .btn-row above
      // it; no padding on top, because the row it belongs to already has 8px
      // underneath and two gaps stacked read as a break between them.
      html += '<div class="micro" style="padding:0 12px 8px">Edited: ' +
        global.App.esc(pending.join(', ')) + '</div>';
    }

    html += '<div class="btn-row"><span class="micro" style="align-self:center">Draw</span>' +
      DRAW_TOOLS.map(function (t) {
        return '<button class="btn' + (drawShape === t.id ? ' primary' : '') +
          '" data-author="tool" data-tool="' + t.id + '" title="' +
          global.App.esc(t.hint) + ' (' + t.key.toUpperCase() + ')">' +
          t.label + '</button>';
      }).join('') +
      '<button class="btn' + (snapOn ? ' primary' : '') + '" data-author="snap" title="' +
      'After a shape is drawn, fit it to the outline printed underneath — by at ' +
      'most ' + Math.round((global.Snap ? global.Snap.TOLERANCE : 0.15) * 100) +
      '%, and only on the drawing, never the photo">Snap</button></div>';

    html += '<div class="btn-row">' +
      '<button class="btn' + (outlineMode ? ' primary' : '') + '" data-author="align-outline"' +
      ' title="Drag the photograph\'s corners until its board edge sits under the drawn one">' +
      (outlineMode ? 'Done aligning' : 'Align outline') + '</button>' +
      '<button class="btn' + (landmarkMode ? ' primary' : '') + '" data-author="landmarks">' +
      (landmarkMode ? 'Stop placing landmarks' : 'Photo landmarks') + '</button>' +
      '<button class="btn" data-author="clear-landmarks">Clear landmarks</button></div>';

    if (outlineMode) {
      var existing = (d.layers || []).find(function (l) { return l.id === 'photo'; });
      var replacing = (existing && existing.landmarks) || [];
      html += '<p class="scope-note">Drag the four cyan corners. The photograph ' +
        'follows as you go — line its board edge up with the drawing\'s. Pan and ' +
        'zoom still work anywhere off a corner.' +
        (replacing.length > 4
          ? ' <strong>This replaces the ' + replacing.length + ' landmarks already ' +
            'placed</strong> — Undo brings them back.'
          : '') + '</p>';
    }

    var photo = (d.layers || []).find(function (l) { return l.id === 'photo'; });
    if (photo && photo.landmarks && photo.landmarks.length) {
      // The solver's residuals live in photo space, but nobody probes a
      // photograph: pull each pair back onto the board through the inverse
      // and report the miss as a fraction of the board itself, which is the
      // space the markers -- and the probe -- actually live in.
      var inv = photo.transform && photo.transform.H
        ? Geom.invert(photo.transform.H) : null;
      html += '<dl class="legend-rows">' + photo.landmarks.map(function (lm, i) {
        var r = null;
        if (inv) {
          var p = Geom.apply(inv, lm.dst[0], lm.dst[1]);
          var rx = p[0] - lm.src[0];
          var ry = p[1] - lm.src[1];
          r = Math.sqrt(rx * rx + ry * ry);
        }
        return '<dt>Landmark ' + (i + 1) + '</dt><dd>' +
          (r == null ? '—' : (r * 100).toFixed(2) + '% of the board') + '</dd>';
      }).join('') + '</dl>';
    }
    html += '</section>';

    // Local edits are invisible by nature -- they look exactly like the data.
    // Saying which markers they cover is the difference between "the file has
    // been improved and I am not seeing it" being obvious and being a mystery.
    var diverged = divergedFromFile();
    var divergedExtra = divergedLayers();
    if (diverged.length || divergedExtra.length) {
      html += '<section class="panel-section"><header>Differs from the data file' +
        '<span class="spacer"></span><span class="count">' +
        (diverged.length + divergedExtra.length) + '</span></header>' +
        '<div class="source-note" style="padding:6px 12px 0">' +
        'These markers are held in this browser and are what you are looking at. ' +
        'Everything else follows <code>data/' +
        global.App.esc((d.id || '').toLowerCase()) + '.coords.json</code>.</div>' +
        '<div class="chiprow" style="padding:8px 12px">' +
        diverged.slice(0, 40).map(function (ref) {
          return '<button class="chip" data-author="select" data-ref="' +
            global.App.esc(ref) + '">' + global.App.esc(ref) + '</button>';
        }).join('') +
        (diverged.length > 40 ? '<span class="micro">+' + (diverged.length - 40) + ' more</span>' : '') +
        '</div>' +
        (divergedExtra.length
          ? '<div class="source-note" style="padding:0 12px 6px">Also held here: ' +
            global.App.esc(divergedExtra.join(', ')) + '.</div>'
          : '') +
        '<div class="btn-row"><button class="btn danger" data-author="take-file">' +
        'Use the data file for all ' + (diverged.length + divergedExtra.length) +
        '</button></div></section>';
    }

    var lost = offBoard(all);
    if (lost.length) {
      html += '<section class="panel-section"><header>Off the board' +
        '<span class="spacer"></span><span class="count">' + lost.length + '</span></header>' +
        '<div class="source-note" style="padding:6px 12px 0">' +
        'Dragged past the edge, where there is nothing left to click. Select one, ' +
        'then undo, restore it, or type a position.</div>' +
        '<div class="chiprow" style="padding:8px 12px">' +
        lost.map(function (i) {
          return '<button class="chip" data-author="select" data-ref="' +
            global.App.esc(i.ref) + '">' + global.App.esc(i.ref) + '</button>';
        }).join('') + '</div></section>';
    }

    if (unplaced.length) {
      html += '<section class="panel-section"><header>' +
        (onBoard ? 'Not on the board' : 'Not on any sheet') +
        '<span class="spacer"></span><span class="count">' + unplaced.length + '</span></header>' +
        '<div class="source-note" style="padding:6px 12px 0">' +
        (onBoard
          ? 'Click one, then drag out its outline on the board — corner to corner ' +
            'for a box, rim to rim across the middle for a circle. A click on its ' +
            'own drops a default box.'
          : 'Drawn on neither sheet. Click one, then drag out its symbol on ' +
            global.App.esc(spaceLabel(space)) + '.') + '</div>' +
        '<div class="chiprow" style="padding:8px 12px">' +
        unplaced.map(function (i) {
          return '<button class="chip" data-arm="' + global.App.esc(i.ref) + '">' +
            global.App.esc(i.ref) + '</button>';
        }).join('') + '</div></section>';
    }

    if (!item) {
      html += '<div class="empty"><strong>Nothing selected</strong>' +
        'Click a marker to edit it. Drag to move, Alt+drag to resize, arrows to nudge, ' +
        'Cmd/Ctrl+Z to undo. <em>Del</em> throws its outline away and waits for a ' +
        'new one — the same as <em>Draw on board</em>.</div>';
      return html;
    }

    html += '<section class="panel-section"><header>Edit ' +
      global.App.esc(item.ref) + '</header>';
    html += '<div class="inspector-grid">';
    html += field('ref', 'Ref', item.ref);
    if (item.isTestPoint) {
      html += field('signal', 'Signal', item.signal || '');
      html += select('rail', 'Rail', Object.keys(d.rails || {}), item.rail);
      html += select('kind', 'Kind', ['wire-loop', 'hv-socket'], item.kind);
      html += select('refPoint', 'Ref point',
        (d.testpoints || []).map(function (t) { return t.ref; }), item.refPoint);
      html += field('nominal', 'Nominal', item.nominal, 'number');
      html += field('tolerance', 'Tol ±', item.tolerance, 'number');
      html += field('tolerancePct', 'Tol ±%', item.tolerancePct, 'number');
      html += field('maxAbs', 'Max |v|', item.maxAbs, 'number');
      html += field('unit', 'Unit', item.unit || 'V');
      html += field('rippleMaxPP', 'Ripple p-p', item.rippleMaxPP, 'number');
      html += field('ratedOutput', 'Rated', item.ratedOutput || '');
      html += field('currentLimit', 'I limit', item.currentLimit || '');
      html += field('condition', 'Condition', item.condition || '');
      html += field('hazard', 'Hazard', item.hazard || '');
    } else {
      html += field('desc', 'Description', item.desc || '');
      html += field('fluke', 'Fluke P/N', item.fluke || '');
      html += field('mfrCode', 'Mfr code', item.mfrCode || '');
      html += field('mfrPart', 'Mfr P/N', item.mfrPart || '');
      html += select('kind', 'Kind',
        ['cap', 'res', 'diode', 'zener', 'transistor', 'ic', 'resnet', 'fuse',
         'jumper', 'relay', 'mech', 'connector', 'switch', 'thermistor', 'part'],
        item.kind);
      html += field('qty', 'Qty', item.qty, 'number');
    }
    html += field('note', 'Note', item.note || '');
    html += field('source', 'Source', item.source || '');
    html += '</div>';

    var g = item.board;
    html += '<div class="micro" style="padding:8px 12px 2px">Board position</div>';
    html += '<div class="inspector-grid">' +
      field('board.x', 'X', g ? round(g.x) : '', 'number') +
      field('board.y', 'Y', g ? round(g.y) : '', 'number') +
      field('board.w', 'W', g ? round(g.w) : '', 'number') +
      field('board.h', 'H', g ? round(g.h) : '', 'number') +
      select('board.shape', 'Shape', SHAPES, g ? g.shape : 'rect') +
      '</div>';

    html += '<div class="btn-row">' +
      '<label style="display:flex;gap:6px;align-items:center"><input type="checkbox" ' +
      'data-flag="verified"' + (item.verified ? ' checked' : '') + '> board verified</label>' +
      '<label style="display:flex;gap:6px;align-items:center"><input type="checkbox" ' +
      'data-flag="schVerified"' + (item.schVerified ? ' checked' : '') + '> schematic verified</label>' +
      '</div>';

    (item.sch || []).forEach(function (s, i) {
      html += '<div class="micro" style="padding:8px 12px 2px">Schematic ' + (i + 1) +
        ' — ' + s.sheet + (s.zone ? ' / ' + s.zone : '') + '</div>';
      html += '<div class="inspector-grid">' +
        field('sch.' + i + '.x', 'X', round(s.x), 'number') +
        field('sch.' + i + '.y', 'Y', round(s.y), 'number') +
        field('sch.' + i + '.w', 'W', round(s.w), 'number') +
        field('sch.' + i + '.h', 'H', round(s.h), 'number') +
        '</div>' +
        '<div class="btn-row"><button class="btn danger" data-author="del-sch" data-i="' + i +
        '">Remove this occurrence</button></div>';
    });

    if (item.states) {
      item.states.forEach(function (st, i) {
        html += '<div class="micro" style="padding:8px 12px 2px">Mode ' + (i + 1) + '</div>';
        html += '<div class="inspector-grid">' +
          field('states.' + i + '.label', 'Label', st.label || '') +
          field('states.' + i + '.nominal', 'Nominal', st.nominal, 'number') +
          field('states.' + i + '.tolerance', 'Tol ±', st.tolerance, 'number') +
          field('states.' + i + '.tolerancePct', 'Tol ±%', st.tolerancePct, 'number') +
          field('states.' + i + '.maxAbs', 'Max |v|', st.maxAbs, 'number') +
          field('states.' + i + '.setup', 'Setup', st.setup || '') +
          field('states.' + i + '.source', 'Source', st.source || '') +
          '</div>';
      });
      html += '<div class="btn-row"><button class="btn" data-author="add-state">Add mode</button></div>';
    }

    html += '<div class="btn-row">' +
      '<button class="btn" data-author="arm" title="Drag out the outline; a plain ' +
      'click drops a default box">' +
      (onBoard ? 'Draw on board' : 'Draw on this sheet') + '</button>' +
      '<button class="btn" data-author="revert-item"' +
      (baselineFor(item.ref) ? '' : ' disabled') +
      ' title="Put this one back where the data file has it">Restore from file</button>' +
      (onBoard
        ? '<button class="btn danger" data-author="unplace">Clear board position</button>'
        : '') + '</div>';
    html += '</section>';
    return html;
  }

  function field(path, label, value, type) {
    return '<label for="a-' + path + '">' + global.App.esc(label) + '</label>' +
      '<input id="a-' + path + '" data-path="' + path + '" type="' + (type || 'text') +
      '" step="any" value="' + global.App.esc(value == null ? '' : value) + '">';
  }

  function select(path, label, options, value) {
    return '<label for="a-' + path + '">' + global.App.esc(label) + '</label>' +
      '<select id="a-' + path + '" data-path="' + path + '">' +
      '<option value=""></option>' +
      options.map(function (o) {
        return '<option value="' + global.App.esc(o) + '"' +
          (o === value ? ' selected' : '') + '>' + global.App.esc(o) + '</option>';
      }).join('') + '</select>';
  }

  function round(v) { return v == null ? '' : Math.round(v * 100000) / 100000; }

  function bindInspector(wrap) {
    wrap.querySelectorAll('[data-path]').forEach(function (input) {
      input.addEventListener('change', function () {
        applyEdit(input.dataset.path, input.value, input.type === 'number');
      });
    });
    wrap.querySelectorAll('[data-flag]').forEach(function (input) {
      input.addEventListener('change', function () {
        var item = BE.lookup(BE.state.selected);
        if (!item) return;
        // The flag is data like any other edit, and Cmd+Z has to take back
        // the tick rather than whatever edit happened to come before it.
        pushUndo(itemEntry(item, 'flag ' + item.ref));
        item[input.dataset.flag] = input.checked;
        commit();
      });
    });
    wrap.querySelectorAll('[data-arm]').forEach(function (btn) {
      btn.addEventListener('click', function () { arm(btn.dataset.arm); });
    });
    wrap.querySelectorAll('[data-author]').forEach(function (btn) {
      btn.addEventListener('click', function () { authorAction(btn.dataset.author, btn); });
    });
  }

  /**
   * Throw away the selected marker's outline in the space on screen and wait
   * for a new one to be drawn. One undo brings the old one back, so this is
   * safe to reach for on a marker you are not sure about.
   */
  function clearAndRedraw(viewer, item) {
    if (!viewer || !item) return;
    var space = viewer.space;
    var existing = geometryOf(item.ref, space, selectedOccurrence());
    if (!existing) {
      arm(item.ref);      // nothing to clear; it wants drawing either way
      return;
    }
    pushUndo(itemEntry(item, 'clear ' + item.ref));
    var was = existing.shape;
    if (space === 'board') {
      delete item.board;
      item.verified = false;
      delete item.placement;
    } else {
      // One occurrence, not every occurrence: a part legitimately drawn twice
      // on a sheet should lose the symbol you were pointing at, not both.
      var occ = selectedOccurrence();
      var i = occ != null && (item.sch || [])[occ] && item.sch[occ].sheet === space
        ? occ
        : (item.sch || []).findIndex(function (o) { return o.sheet === space; });
      if (i >= 0) item.sch.splice(i, 1);
      selOcc = null;      // indexes past the splice no longer line up
      if (!(item.sch || []).length) {
        delete item.sch;
        item.schVerified = false;
      }
    }
    commit();
    arm(item.ref);
    // arm() seeds the tool from what is there, and there is nothing there now.
    if (was && SHAPES.indexOf(was) >= 0) drawShape = was;
    host.toast(item.ref + ' cleared on ' + spaceLabel(space) + ' — draw it again, or undo');
  }

  /** Wait for the gesture that will place `ref`, and say what to do. */
  function arm(ref) {
    // While an alignment mode is on, every press is claimed for a landmark or
    // a corner drag and the promised draw can never open -- so arming puts
    // the alignment tools away, the way the modes already evict each other.
    if (outlineMode) setOutlineMode(false);
    landmarkMode = false;
    pendingLandmark = null;
    armedRef = ref;
    api.draw = null;
    var g = geometryOf(ref, currentSpace());
    if (g && g.shape && SHAPES.indexOf(g.shape) >= 0) drawShape = g.shape;
    host.toast('Drag out ' + ref + ' on ' + spaceLabel(currentSpace()) + ' — ' +
      (drawShape === 'rect' ? 'corner to corner' : 'rim to rim across the middle'));
    var viewer = global.App.viewer();
    if (viewer) viewer.draw();
    host.refresh();
  }

  function applyEdit(path, raw, numeric) {
    var item = BE.lookup(BE.state.selected);
    if (!item) return;
    var value = raw === '' ? null : (numeric ? parseFloat(raw) : raw);
    if (numeric && value != null && isNaN(value)) return;

    // Validate before recording the edit, so a refused one leaves no step in
    // the history for someone to undo back through.
    if (path === 'ref' && value && value !== item.ref && BE.lookup(value)) {
      host.toast('A part called ' + value + ' already exists');
      return;
    }
    if (path === 'refPoint' && value && !BE.lookup(value)) {
      host.toast('No test point called ' + value);
      return;
    }
    pushUndo(itemEntry(item, 'edit ' + item.ref + ' ' + path));

    if (path === 'ref' && value && value !== item.ref) {
      var d = BE.state.assembly;
      delete d.byRef[item.ref];
      item.ref = value;
      d.byRef[value] = item;
      BE.set({ selected: value });
    } else {
      // The inspector shows the board fields even for an unplaced part, and
      // setPath alone would conjure a sizeless box pinned to the drawing's
      // corner out of the first one typed. Seed the same default a click
      // drops, centred, so a typed field lands on something real.
      if (path.indexOf('board.') === 0 && !item.board) {
        var dflt = item.isTestPoint ? { w: 0.009, h: 0.011 } : DEFAULT_SIZE;
        item.board = { x: 0.5, y: 0.5, w: dflt.w, h: dflt.h,
                       shape: item.isTestPoint ? 'point' : 'rect' };
        host.toast(item.ref + ' had no board box — started from a default at the centre');
      }
      setPath(item, path, value);
      // A typed coordinate is as capable of putting a box off the drawing as a
      // dragged one, so it goes through the same fence.
      var sch = path.match(/^sch\.(\d+)\./);
      if (path.indexOf('board.') === 0) clampGeometry(item.board);
      else if (sch) {
        var occ = clampGeometry((item.sch || [])[+sch[1]]);
        if (occ) occ.zone = zoneFor(occ.sheet, occ.x, occ.y);
      }
    }
    commit();
  }

  function setPath(obj, path, value) {
    var parts = path.split('.');
    var target = obj;
    for (var i = 0; i < parts.length - 1; i++) {
      var k = parts[i];
      if (target[k] == null) target[k] = /^\d+$/.test(parts[i + 1]) ? [] : {};
      target = target[k];
    }
    var last = parts[parts.length - 1];
    if (value == null) delete target[last]; else target[last] = value;
  }

  function authorAction(act, btn) {
    var item = BE.state.selected ? BE.lookup(BE.state.selected) : null;
    if (act === 'export-coords') exportCoords();
    else if (act === 'export-data') exportDataFile();
    else if (act === 'export-all') exportBundle(false);
    else if (act === 'export-all-force') exportBundle(true);
    else if (act === 'undo') undo();
    else if (act === 'redo') redo();
    else if (act === 'revert-item' && item) revertItem(item);
    else if (act === 'select' && btn.dataset.ref) BE.set({ selected: btn.dataset.ref });
    else if (act === 'revert') {
      if (confirm('Discard all local edits and reload the file as shipped?')) {
        localStorage.removeItem(key());
        location.reload();
      }
    } else if (act === 'align-outline') {
      setOutlineMode(!outlineMode);
    } else if (act === 'landmarks') {
      landmarkMode = !landmarkMode;
      pendingLandmark = null;
      if (landmarkMode) setOutlineMode(false);
      host.toast(landmarkMode
        ? 'Click a feature on the drawing, then the same feature on the photo'
        : 'Landmark placement off');
    } else if (act === 'clear-landmarks') {
      var photo = landmarkStore();
      if (photo) {
        pushUndo(layerEntry(photo, 'clear landmarks'));
        photo.landmarks = [];
        photo.transform = null;
      }
      // The quad is drawn from the transform that just went away, so re-seed
      // it rather than leaving four handles describing a fit no longer there.
      if (outlineMode) outlineQuad = seedOutline();
      commit();
    } else if (act === 'arm' && item) {
      arm(item.ref);
    } else if (act === 'take-file') {
      var n = divergedFromFile().length + divergedLayers().length;
      if (confirm('Put ' + n + ' edit(s) back to what the data file '
                  + 'says, discarding the local versions?')) {
        localStorage.removeItem(key());
        location.reload();
      }
    } else if (act === 'tool') {
      drawShape = btn.dataset.tool;
    } else if (act === 'snap') {
      snapOn = !snapOn;
      snapWarned = false;
    } else if (act === 'unplace' && item) {
      pushUndo(itemEntry(item, 'clear ' + item.ref));
      delete item.board;
      item.verified = false;
      commit();
    } else if (act === 'del-sch' && item) {
      pushUndo(itemEntry(item, 'remove occurrence of ' + item.ref));
      item.sch.splice(+btn.dataset.i, 1);
      selOcc = null;      // indexes past the splice no longer line up
      commit();
    } else if (act === 'add-state' && item) {
      pushUndo(itemEntry(item, 'add mode to ' + item.ref));
      item.states = item.states || [];
      item.states.push({ label: 'New mode', nominal: 0, tolerance: 1 });
      commit();
    }
    host.refresh();
  }

  /* ---- persistence and export ---- */

  function commit() {
    var d = BE.state.assembly;
    if (d) dirty = persistEdits(d);
    // The photo layer is an <img> the viewer positions with a CSS transform,
    // and refresh() rebuilds the panel and the canvas but never rewrites that.
    // So anything that changes the homography -- placing the fourth landmark,
    // clearing them, dragging an outline corner, undoing any of it -- left the
    // picture where it was until some unrelated action forced a full
    // re-render. Every one of those paths ends here.
    var v = global.App && global.App.viewer && global.App.viewer();
    if (v && v.applyLayerTransforms) v.applyLayerTransforms();
    host.refresh();
  }

  // The halves of an item the placement diff already carries, plus the
  // derived index flag. Everything else on a record is a field edit.
  var PLACEMENT_KEYS = { ref: 1, board: 1, sch: 1, verified: 1, schVerified: 1,
                         placement: 1, placementNote: 1, isTestPoint: 1 };

  /** The record without its geometry: the part of an item the inspector's
   *  field inputs edit, compared and stored as one piece. */
  function fieldsOf(item) {
    var out = {};
    Object.keys(item).forEach(function (k) {
      if (!PLACEMENT_KEYS[k]) out[k] = item[k];
    });
    return out;
  }

  /**
   * Only what differs from the data file.
   *
   * Storing the whole coordinate set meant the file could never change again:
   * a snapshot taken before the component bodies existed carried its own copy
   * of every marker, so re-opening the editor put all 250 of them back as they
   * were and silently undid work that had since shipped. Nothing said so --
   * the file on disk still held the new geometry, and the screen did not.
   *
   * Persisting the difference instead means a marker nobody touched simply
   * follows the file, and only the ones actually edited are remembered. The
   * same discipline covers the whole record: field edits, renames and
   * deliberate deletions ride in the entry beside the geometry, and the photo
   * alignment and sheet grids are diffed rather than copied, for the same
   * reason the placements are.
   *
   * Entries are keyed by the designator the file ships and matched to live
   * items by identity -- keyed by the live name, a rename would read as one
   * part deleted and an unknown one invented, and the next load would wipe
   * the placement it was meant to keep.
   */
  function localEdits(d) {
    var full = collectCoords(d);
    var base = baselines[d.id] ||
      { placement: {}, items: {}, fields: {}, layers: {}, sheets: {} };
    var out = { assembly: full.assembly, partial: true, placement: {},
                layers: {}, sheets: {} };
    Object.keys(base.items).forEach(function (fileRef) {
      var item = base.items[fileRef];
      var entry = full.placement[item.ref];
      var stored = null;
      if (!entry) {
        // The item is still here with no geometry left: a deletion if the
        // file gave it some, nothing worth recording if it never had any.
        if (base.placement[fileRef]) stored = { cleared: true };
      } else if (JSON.stringify(entry) !== JSON.stringify(base.placement[fileRef])) {
        stored = entry;
      }
      var fields = fieldsOf(item);
      if (JSON.stringify(fields) !== base.fields[fileRef]) {
        stored = stored || entry || {};
        stored.fields = fields;
      }
      if (item.ref !== fileRef) {
        stored = stored || entry || {};
        stored.ref = item.ref;
      }
      if (stored) out.placement[fileRef] = stored;
    });
    Object.keys(full.layers).forEach(function (id) {
      if (JSON.stringify(full.layers[id]) !== JSON.stringify(base.layers[id])) {
        out.layers[id] = full.layers[id];
      }
    });
    Object.keys(full.sheets).forEach(function (id) {
      if (JSON.stringify(full.sheets[id]) !== JSON.stringify(base.sheets[id])) {
        out.sheets[id] = full.sheets[id];
      }
    });
    return out;
  }

  /** Whether a computed diff holds anything at all. */
  function hasEdits(edits) {
    return !!(Object.keys(edits.placement || {}).length ||
              Object.keys(edits.layers || {}).length ||
              Object.keys(edits.sheets || {}).length);
  }

  /**
   * Write the diff, or clear it. A session undone back to the shipped state
   * has to read clean -- no stored entry, no badge, no diff list -- rather
   * than leaving a husk that marks the board edited forever.
   */
  function persistEdits(dataset) {
    var edits = localEdits(dataset);
    var any = hasEdits(edits);
    var name = 'fluke5700a.author.' + dataset.id;
    try {
      if (any) localStorage.setItem(name, JSON.stringify(edits));
      else localStorage.removeItem(name);
    } catch (err) { /* session-only is acceptable */ }
    return any;
  }

  /** Live designators whose record no longer matches the data file. */
  function divergedFromFile() {
    var d = BE.state.assembly;
    var base = d && baselines[d.id];
    if (!base) return [];
    // The panel names what the store holds -- the same diff, so the badge,
    // the list and localStorage can never disagree with each other.
    return Object.keys(localEdits(d).placement).map(function (fileRef) {
      var item = base.items[fileRef];
      return item ? item.ref : fileRef;
    }).sort();
  }

  /** Layer alignments and sheet grids held locally over the file's. */
  function divergedLayers() {
    var d = BE.state.assembly;
    if (!d || !baselines[d.id]) return [];
    var edits = localEdits(d);
    return Object.keys(edits.layers).map(function (id) {
      return id + ' alignment';
    }).concat(Object.keys(edits.sheets).map(function (id) {
      return id + ' grid';
    }));
  }

  /**
   * Take a dataset under authorship: remember it exactly as the file shipped
   * it *before* laying local edits over the top, so "restore from file" has
   * something true to restore to.
   */
  function adopt(dataset) {
    // The snapshot must not share objects with the live items: edits mutate
    // geometry in place, and a baseline reached through the same references
    // drifts along with them -- after which an undo back to the shipped
    // state compares unequal to its own baseline forever.
    var base = clone(collectCoords(dataset));
    // Items are remembered by identity as well as by designator, which is
    // what lets a rename be told apart from a deletion when the store is
    // written, and field edits find their record again on the next load.
    base.items = {};
    base.fields = {};
    BE.items(dataset).forEach(function (item) {
      base.items[item.ref] = item;
      base.fields[item.ref] = JSON.stringify(fieldsOf(item));
    });
    baselines[dataset.id] = base;
    restore(dataset);
    repairOffBoard(dataset);
  }

  /**
   * A stored position outside board space is never a real edit: there is
   * nothing there to point at and no marker left to click, so it is a drag
   * that got away. Put those back where the file has them and say so, rather
   * than reopening the page with a part stranded out of reach.
   */
  function repairOffBoard(dataset) {
    var base = (baselines[dataset.id] || {}).placement || {};
    var fixed = [];
    offBoard(BE.items(dataset)).forEach(function (item) {
      var shipped = base[item.ref];
      if (!shipped || !shipped.board) return;   // nothing to fall back to;
      item.board = clone(shipped.board);        // leave it for the panel to list
      // The drag that got away also stamped the marker hand-verified, and a
      // repair that leaves the stamp keeps the part in the diff list forever
      // over a flag nobody meant. The whole board half goes back as shipped.
      item.verified = !!shipped.verified;
      if (shipped.placement) item.placement = shipped.placement;
      else delete item.placement;
      if (shipped.placementNote) item.placementNote = shipped.placementNote;
      else delete item.placementNote;
      fixed.push(item.ref);
    });
    if (!fixed.length) return;
    // The store is rewritten as the diff it always is: a full snapshot here
    // once swallowed every deliberate deletion beside the repaired marker.
    persistEdits(dataset);
    // After init, so the message is not wiped by the first render.
    setTimeout(function () {
      host.toast(fixed.join(', ') + ' had been dragged off the board — ' +
        'restored from the data file');
    }, 0);
  }

  function restore(dataset) {
    var raw;
    try {
      raw = JSON.parse(localStorage.getItem('fluke5700a.author.' + dataset.id));
    } catch (err) { return; }
    if (!raw) return;
    if (!raw.partial) raw = trimToEdits(dataset, raw);
    applyCoords(dataset, raw);
    if (hasEdits(raw)) dirty = true;
  }

  /**
   * Reduce a whole-set snapshot from an older version to the edits in it.
   *
   * Such a snapshot cannot say which entries were deliberate and which are
   * just a copy of what the file said at the time, so anything matching the
   * file today is dropped as the no-op it is. What is left over is genuinely
   * different from the file -- either an edit worth keeping or a marker the
   * file has since improved -- and the panel now says how many there are and
   * offers to take the file's version, instead of the screen quietly
   * disagreeing with the data.
   */
  function trimToEdits(dataset, raw) {
    var base = baselines[dataset.id] || { placement: {}, layers: {}, sheets: {} };
    var kept = {};
    Object.keys(raw.placement || {}).forEach(function (ref) {
      if (JSON.stringify(raw.placement[ref]) !== JSON.stringify(base.placement[ref])) {
        kept[ref] = raw.placement[ref];
      }
    });
    // The snapshot's layers and grids get the same treatment: matching the
    // file they are no-ops, and carried forward they would pin this browser
    // to the alignment of the day the snapshot was taken.
    var keptLayers = {};
    Object.keys(raw.layers || {}).forEach(function (id) {
      if (JSON.stringify(raw.layers[id]) !== JSON.stringify(base.layers[id])) {
        keptLayers[id] = raw.layers[id];
      }
    });
    var keptSheets = {};
    Object.keys(raw.sheets || {}).forEach(function (id) {
      if (JSON.stringify(raw.sheets[id]) !== JSON.stringify(base.sheets[id])) {
        keptSheets[id] = raw.sheets[id];
      }
    });
    var trimmed = Object.assign({}, raw, { placement: kept, layers: keptLayers,
                                           sheets: keptSheets, partial: true });
    try {
      if (hasEdits(trimmed)) {
        localStorage.setItem('fluke5700a.author.' + dataset.id, JSON.stringify(trimmed));
      } else {
        localStorage.removeItem('fluke5700a.author.' + dataset.id);
      }
    } catch (err) { /* session-only is acceptable */ }
    return trimmed;
  }

  function collectCoords(d) {
    var placement = {};
    BE.items(d).forEach(function (item) {
      var entry = {};
      if (item.board) entry.board = item.board;
      if (item.sch && item.sch.length) {
        entry.sch = item.sch.map(function (s) {
          var copy = Object.assign({}, s);
          delete copy.zone;          // derived at assembly time
          return copy;
        });
      }
      if (item.verified) entry.verified = true;
      if (item.schVerified) entry.schVerified = true;
      // Provenance travels with the position, or an export would quietly
      // downgrade every hand-checked marker back to "passes agreed".
      if (item.placement) entry.placement = item.placement;
      if (item.placementNote) entry.placementNote = item.placementNote;
      if (Object.keys(entry).length) placement[item.ref] = entry;
    });

    var layers = {};
    (d.layers || []).forEach(function (l) {
      if (l.transform && l.transform !== 'identity') {
        layers[l.id] = { transform: l.transform };
        if (l.landmarks) layers[l.id].landmarks = l.landmarks;
      } else if (l.landmarks && l.landmarks.length) {
        layers[l.id] = { landmarks: l.landmarks };
      }
    });

    var sheets = {};
    (d.schematics || []).forEach(function (s) {
      if (s.grid) sheets[s.id] = { grid: s.grid };
    });

    return { assembly: d.id, placement: placement, layers: layers, sheets: sheets };
  }

  function applyCoords(d, coords) {
    var placed = [];
    Object.keys(coords.placement || {}).forEach(function (ref) {
      var item = d.byRef[ref];
      if (!item) return;
      var entry = coords.placement[ref];
      // A stored rename: the entry is keyed by the designator the file
      // ships and carries the one the author gave the part.
      if (entry.ref && entry.ref !== item.ref && !d.byRef[entry.ref]) {
        delete d.byRef[item.ref];
        item.ref = entry.ref;
        d.byRef[item.ref] = item;
      }
      // Stored field edits replace the record's fields wholesale: a field
      // the author deleted has to stay deleted, which assigning over the
      // file's copy could never say.
      if (entry.fields) {
        Object.keys(item).forEach(function (k) {
          if (!PLACEMENT_KEYS[k]) delete item[k];
        });
        Object.assign(item, clone(entry.fields));
      }
      // A stored deletion, which has no shape of its own to restore.
      if (entry.cleared) {
        delete item.board;
        delete item.sch;
        item.verified = false;
        item.schVerified = false;
        return;
      }
      // The entry is a full snapshot of the item's geometry, so a half
      // missing from it was cleared in the editor, not left alone.
      if (entry.board) item.board = entry.board; else delete item.board;
      if (entry.sch) { item.sch = entry.sch; placed.push(item); }
      else delete item.sch;
      item.verified = !!entry.verified;
      item.schVerified = !!entry.schVerified;
      if (entry.placement) item.placement = entry.placement;
      else delete item.placement;
      if (entry.placementNote) item.placementNote = entry.placementNote;
      else delete item.placementNote;
    });
    Object.keys(coords.layers || {}).forEach(function (id) {
      var layer = (d.layers || []).find(function (l) { return l.id === id; });
      if (!layer) return;
      if (coords.layers[id].transform) layer.transform = coords.layers[id].transform;
      if (coords.layers[id].landmarks) layer.landmarks = coords.layers[id].landmarks;
    });
    Object.keys(coords.sheets || {}).forEach(function (id) {
      var sheet = (d.schematics || []).find(function (s) { return s.id === id; });
      if (sheet && coords.sheets[id].grid) sheet.grid = coords.sheets[id].grid;
    });
    // Stored sch copies carry no zone -- collectCoords strips it as derived
    // -- so stamp it back, after the grids, possibly themselves restored
    // just above, are in place.
    placed.forEach(function (item) {
      item.sch.forEach(function (s) {
        s.zone = zoneFor(s.sheet, s.x, s.y, d);
      });
    });
  }

  function exportCoords() {
    var d = BE.state.assembly;
    global.App.download(d.id.toLowerCase() + '.coords.json',
      JSON.stringify(collectCoords(d), null, 1), 'application/json');
    host.toast('Save it as data/' + d.id.toLowerCase() +
      '.coords.json, then run tools/assemble.py');
  }

  /**
   * Which boards this editor has unsaved edits for.
   *
   * Author state is mirrored one localStorage key per assembly, so the
   * question has an exact answer rather than an estimate -- and that is what
   * lets the bundle default to the boards actually touched. Rewriting all
   * thirty-four files when two changed is the churn the overrides pipeline
   * already goes out of its way to avoid.
   */
  function editedAssemblies() {
    return BE.list().filter(function (d) {
      try {
        return !!global.localStorage.getItem('fluke5700a.author.' + d.id);
      } catch (err) { return false; }     // storage gone: claim nothing
    }).map(function (d) { return d.id; });
  }

  /** The dataset as the data file writes it, without the derived indexes. */
  function datasetCopy(d) {
    return JSON.parse(JSON.stringify(d, function (k, v) {
      return (k === 'byRef' || k === 'probeByRef' || k === 'isTestPoint') ? undefined : v;
    }));
  }

  /**
   * Every board worth writing, in one file.
   *
   * A single JSON rather than an archive: a zip would mean hand-rolling a
   * store-only encoder -- local headers, central directory, a CRC32 table --
   * in a page that deliberately has no build step and no libraries, to produce
   * something nobody can read without unpacking it. The bundle instead follows
   * the shape the service export already uses, and tools/unpack_export.py
   * writes the individual files the rest of the pipeline expects.
   *
   * coords and data come from the same two producers the per-board buttons
   * use, so the bundle and the single-board exports cannot drift apart.
   */
  function exportBundle(all) {
    var edited = {};
    editedAssemblies().forEach(function (id) { edited[id] = true; });
    var wanted = BE.list().filter(function (d) { return all || edited[d.id]; });
    if (!wanted.length) {
      host.toast('No board has edits to export');
      return;
    }
    var bundle = {
      format: 'fluke5700a.author.bundle',
      version: 1,
      exportedAt: new Date().toISOString(),
      assemblies: {}
    };
    wanted.forEach(function (d) {
      bundle.assemblies[d.id] = {
        edited: !!edited[d.id],
        coords: collectCoords(d),
        data: datasetCopy(d)
      };
    });
    // The bench date, not UTC: a bundle exported late in the evening must not
    // be named for tomorrow, the same reason the service export dates itself
    // from the local clock.
    var now = new Date();
    var two = function (n) { return (n < 10 ? '0' : '') + n; };
    var stamp = now.getFullYear() + '-' + two(now.getMonth() + 1) + '-' + two(now.getDate());
    global.App.download('a-author-bundle-' + stamp + '.json',
      JSON.stringify(bundle, null, 1), 'application/json');
    host.toast(wanted.length + ' board' + (wanted.length === 1 ? '' : 's') +
      ' exported — run tools/unpack_export.py on it');
  }

  function exportDataFile() {
    var d = BE.state.assembly;
    var copy = datasetCopy(d);
    var text = '// Exported from Author Mode on ' + new Date().toISOString() + '\n' +
      'BoardExplorer.register(' + JSON.stringify(copy, null, 1) + ');\n';
    global.App.download(d.id.toLowerCase() + '.js', text, 'text/javascript');
    host.toast('Save it as data/' + d.id.toLowerCase() + '.js');
  }

  Author.drag = null;
  Author.draw = null;         // the outline being swept out, while one is
  api = Author;
  global.Author = Author;
})(window);
