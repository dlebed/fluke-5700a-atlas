/*
 * viewer.js — the pan/zoom board and schematic view.
 *
 * Layer images are real <img> elements positioned with a CSS transform, so the
 * browser resamples them and zooming stays sharp at any magnification. The
 * photograph is warped into board space with matrix3d, which is the only way to
 * apply a projective transform to an image in CSS -- that is what makes a single
 * set of coordinates land correctly on the drawing and on the photo alike.
 *
 * Markers are drawn on a transparent canvas above the images. Everything is
 * positioned from one coordinate space at a time: either board space, or the
 * space of one schematic sheet.
 */
(function (global) {
  'use strict';

  var BE = global.BoardExplorer;
  var Geom = global.Geom;

  // Scale is screen pixels per unit of board width, so its useful range depends
  // entirely on the window: the limits are expressed as multiples of whatever
  // scale fits the board, not as absolute numbers.
  var MIN_ZOOM = 0.4, MAX_ZOOM = 60;

  function Viewer(root, opts) {
    this.root = root;
    this.opts = opts || {};
    this.scale = 1;
    this.tx = 0;
    this.ty = 0;
    this.space = null;      // set by setSpace; null so the first call is not
                            // mistaken for "already showing this space"
    this.layers = {};       // id -> {img, transform, natural}
    this.aspect = 1;        // height/width of the space's base image
    this.aspectKnown = false;
    this.needsFit = true;
    this.pendingFocus = null; // a focus asked for before the image could size it
    this.flashRef = null;     // marker currently being pulsed to help locate it
    this.flashAt = 0;
    this.flashTimer = null;
    this.items = [];        // {ref, item, x, y, w, h, shape}
    this.pointer = null;
    this.dragging = null;
    this.touchPoints = {};  // pointerId -> last position, touch pointers only
    this.pinch = null;      // {a, b, dist, mid} while two fingers are down
    this.verdicts = {};     // ref -> 'pass' | 'marginal' | 'fail'
    this.build();
  }

  Viewer.prototype.build = function () {
    var self = this;
    this.root.classList.add('viewer');
    this.stage = document.createElement('div');
    this.stage.className = 'viewer-stage';
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'viewer-canvas';
    this.root.appendChild(this.stage);
    this.root.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');

    this.ro = new ResizeObserver(function () { self.resize(); });
    this.ro.observe(this.root);

    this.canvas.addEventListener('wheel', function (e) { self.onWheel(e); }, { passive: false });
    this.canvas.addEventListener('pointerdown', function (e) { self.onPointerDown(e); });
    this.canvas.addEventListener('pointermove', function (e) { self.onPointerMove(e); });
    this.canvas.addEventListener('pointerup', function (e) { self.onPointerUp(e); });
    this.canvas.addEventListener('pointercancel', function (e) { self.onPointerUp(e); });
    this.canvas.addEventListener('pointerleave', function () {
      self.pointer = null;
      if (self.opts.onHover) self.opts.onHover(null);
      self.draw();
    });
    this.canvas.addEventListener('dblclick', function (e) {
      self.zoomAt(self.eventPos(e), 1.8);
    });
  };

  /* ---- space and layers ------------------------------------------------ */

  /**
   * Point the viewer at a coordinate space.
   * space === 'board'  -> dataset.layers, items positioned from item.board
   * space === sheet id -> that schematic sheet, items positioned from item.sch
   */
  Viewer.prototype.setSpace = function (space, dataset) {
    // Keeping the view means keeping the zoom, the pan and the known aspect
    // ratio -- which is only safe when the picture underneath is the same
    // picture, and the same picture means there is nothing to do at all, so
    // keeping the view and returning early are one decision. Comparing the
    // space alone said yes to a change of board, since both are 'board': the
    // new drawing then rendered at the old one's fit, and because a fit made
    // against a known aspect marks itself done, the new image's load handler
    // skipped the corrective re-fit. Two or three boards in, the compounding
    // error put the drawing off screen entirely -- a black stage with a few
    // floating markers, no spinner and nothing said.
    if (this.space === space && this.dataset === dataset) return;
    this.space = space;
    this.dataset = dataset;
    // A new space brings a new base image, so the aspect ratio is unknown
    // again until that image loads and the view must be re-fitted then.
    this.aspectKnown = false;
    this.needsFit = true;
    this.pendingFocus = null;
    this.flashRef = null;   // a pulse belongs to the space it started in
    this.stage.innerHTML = '';
    this.layers = {};

    var defs = space === 'board'
      ? (dataset.layers || [])
      : (dataset.schematics || []).filter(function (s) { return s.id === space; })
          .map(function (s) { return { id: s.id, src: s.src, transform: 'identity' }; });

    var self = this;
    defs.forEach(function (def) {
      var img = document.createElement('img');
      img.className = 'viewer-layer';
      img.alt = def.label || def.id;
      img.decoding = 'async';
      img.dataset.layer = def.id;
      img.addEventListener('load', function () {
        var rec = self.layers[def.id];
        // setSpace() may have replaced this space's layers while the image was
        // still loading. On a sheet change rec is gone and this threw; on an
        // assembly change the id survives and the stale size was written into
        // the new board -- which then set the aspect ratio, re-fitted and
        // drained pendingFocus against the previous board's shape.
        if (!rec || rec.img !== img) return;
        rec.natural = { w: img.naturalWidth, h: img.naturalHeight };
        // The first layer of a space defines its aspect ratio; for the board
        // that is the drawing, which board space is defined against. Until it
        // has loaded the aspect is a guess, so any fit made before this point
        // was computed against the wrong shape and has to be redone.
        if (def.transform === 'identity') {
          self.aspect = img.naturalHeight / img.naturalWidth;
          self.aspectKnown = true;
          if (self.needsFit) self.fit();
          // Someone asked to be taken to a part on this space before it could
          // be sized. That fit is what they would have landed on had they not
          // asked, so the request outlives it.
          if (self.pendingFocus) {
            var want = self.pendingFocus;
            self.pendingFocus = null;
            self.focus(want.box, want.zoom);
          }
        }
        self.applyLayerTransforms();
        self.draw();
      });
      img.src = def.src;
      self.stage.appendChild(img);
      self.layers[def.id] = { img: img, def: def, natural: null };
    });

    this.scale = 1; this.tx = 0; this.ty = 0;
    this.applyLayerTransforms();
  };

  /** Normalised space coords -> aspect-corrected unit coords. */
  Viewer.prototype.toUnit = function (x, y) { return [x, y * this.aspect]; };

  Viewer.prototype.spaceToScreen = function (x, y) {
    var u = this.toUnit(x, y);
    return [u[0] * this.scale + this.tx, u[1] * this.scale + this.ty];
  };

  Viewer.prototype.screenToSpace = function (px, py) {
    return [(px - this.tx) / this.scale, (py - this.ty) / this.scale / this.aspect];
  };

  /**
   * Place each layer image. A layer whose transform is a homography maps board
   * space onto its own image, so the image must be warped by the inverse to
   * bring it into board space before the view transform is applied.
   */
  Viewer.prototype.applyLayerTransforms = function () {
    var self = this;
    // view: unit space -> screen pixels
    var view = Geom.viewMatrix(this.scale, this.tx, this.ty);
    // unit correction: board space -> unit space
    var unit = [1, 0, 0, 0, this.aspect, 0, 0, 0, 1];

    Object.keys(this.layers).forEach(function (id) {
      var rec = self.layers[id];
      if (!rec.natural) return;
      // image pixels -> the layer's own normalised space
      var px = [1 / rec.natural.w, 0, 0, 0, 1 / rec.natural.h, 0, 0, 0, 1];
      var toBoard;
      var t = rec.def.transform;
      if (!t || t === 'identity') {
        toBoard = px;
      } else {
        var H = t.H || t;
        var inv = Geom.invert(H);
        // A degenerate homography would collapse the image; leave it where it
        // is and let the caller decide whether to show the layer at all.
        if (!inv) return;
        toBoard = Geom.multiply(inv, px);
      }
      rec.img.style.transform = Geom.toMatrix3d(
        Geom.multiply(view, Geom.multiply(unit, toBoard)));
    });
    // Anything drawn in screen space over the layers -- the swipe seam's clip
    // is one -- has to follow every pan and zoom, and this is the one place
    // every transform change passes through.
    if (this.opts.onTransform) this.opts.onTransform(this);
  };

  /* ---- view control ---------------------------------------------------- */

  Viewer.prototype.resize = function () {
    var rect = this.root.getBoundingClientRect();
    var dpr = global.devicePixelRatio || 1;
    // Someone who has not zoomed in expects the whole board to stay in view
    // when the window changes size; someone who has zoomed expects to stay
    // where they were.
    var wasFitted = this.fitScale && Math.abs(this.scale - this.fitScale) < 0.5;
    this.width = rect.width;
    this.height = rect.height;
    this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
    this.canvas.style.width = rect.width + 'px';
    this.canvas.style.height = rect.height + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Re-fit only if there is something to fit to. A hidden pane reports 0x0 --
    // the secondary viewport is display:none outside Split view -- and fitting
    // to that would call straight back into resize().
    if (wasFitted && this.aspectKnown && this.width && this.height) this.fit();
    else this.draw();
  };

  Viewer.prototype.fit = function (pad) {
    // A hidden pane has no size to fit to, and asking resize() again will not
    // conjure one -- so measure at most once and then give up. Leaving Split
    // view fires the ResizeObserver with a 0x0 rect while the pane is still
    // marked fitted, and without both halves of this guard resize() and fit()
    // call each other until the stack goes.
    if (!this.width) this.resize();
    if (!this.width || !this.height) return;
    var p = pad == null ? 12 : pad;
    var sx = (this.width - p * 2) / 1;
    var sy = (this.height - p * 2) / this.aspect;
    this.fitScale = Math.max(1, Math.min(sx, sy));
    this.scale = this.fitScale;
    this.tx = (this.width - this.scale) / 2;
    this.ty = (this.height - this.scale * this.aspect) / 2;
    // Only a fit made against the real aspect ratio counts as done; one made
    // before the image loaded has to be repeated once it arrives.
    this.needsFit = !this.aspectKnown;
    this.applyLayerTransforms();
    this.draw();
  };

  Viewer.prototype.clampScale = function (scale) {
    var base = this.fitScale || scale;
    return Math.max(base * MIN_ZOOM, Math.min(base * MAX_ZOOM, scale));
  };

  Viewer.prototype.zoomAt = function (pt, factor) {
    var before = this.screenToSpace(pt[0], pt[1]);
    this.scale = this.clampScale(this.scale * factor);
    var after = this.spaceToScreen(before[0], before[1]);
    this.tx += pt[0] - after[0];
    this.ty += pt[1] - after[1];
    this.applyLayerTransforms();
    this.draw();
  };

  /**
   * Centre the view on a marker. `zoom` is a multiple of the fit scale, so
   * "6" means six times the whole-board view regardless of window size.
   *
   * `box` is a marker geometry, so x,y is its centre — the same convention
   * screenBox() uses. Every caller passes one straight out of the data.
   *
   * A fixed zoom only works while every marker is a scrap of silkscreen
   * lettering. A marker that is the component body can be forty times that,
   * and eight times the whole board then fills the window with one capacitor.
   * So the requested zoom is a ceiling, backed off far enough that the marker
   * fits in half the window and you can see what it sits next to.
   */
  /**
   * Bring a part into view without changing how far in you are.
   *
   * Selecting a part used to zoom to it, which fought the reader: if the whole
   * board was fitted on screen they lost that overview, and if they had already
   * chosen a working magnification it was taken away and replaced with
   * something else -- often far too close, because the zoom was computed from
   * the marker's size and a small part implies a huge magnification.
   *
   * The zoom is the reader's setting, so it is left alone and only the frame
   * moves. When the whole space is already fitted there is nothing to move to
   * either, and the pan is skipped entirely rather than nudging a view that
   * already shows everything.
   *
   * `zoom` is still accepted so old calls do not break, and is ignored.
   */
  Viewer.prototype.focus = function (box, zoom) {
    // Before the space's base image has loaded there is no real aspect ratio to
    // place anything against, and the fit that its arrival triggers would undo
    // this anyway. Hold the request and carry it out when the image lands.
    if (!this.aspectKnown) { this.pendingFocus = { box: box, zoom: zoom }; return; }
    this.pendingFocus = null;
    if (!this.fitScale) this.fit();
    // Panning would only shift the picture for no gain when the marker is
    // already fully on screen -- which covers the fitted board and any zoomed
    // view the part happens to sit in. The judgement has to come from the
    // marker itself, not from the zoom: dragging changes no scale, so a board
    // panned half off screen at fit zoom still reads as "fitted", and the
    // scale it would be compared against goes stale when the window is
    // resized while zoomed in.
    var b = this.screenBox(box);
    var inView = b.x >= 0 && b.y >= 0 &&
                 b.x + b.w <= this.width && b.y + b.h <= this.height;
    if (!inView) {
      var u = this.toUnit(box.x, box.y);
      this.tx = this.width / 2 - u[0] * this.scale;
      this.ty = this.height / 2 - u[1] * this.scale;
      this.applyLayerTransforms();
    }
    this.draw();
  };

  /**
   * A short pulse around a marker, to catch the eye.
   *
   * Locating one part among three hundred on a fitted board is the thing the
   * eye is worst at, and now that selecting no longer zooms, nothing else moves
   * to say where it went. A ring that expands and fades does that in about half
   * a second -- long enough for the eye to follow it home, short enough that it
   * is over before it becomes something you wait for on every click.
   */
  Viewer.prototype.flash = function (ref) {
    if (!ref) return;
    this.flashRef = ref;
    this.flashAt = (global.performance || Date).now();
    // Always restart the loop rather than leaving it to an existing run to
    // notice. requestAnimationFrame does not fire while the tab is in the
    // background, so a run started there never reaches its end and never
    // clears its own handle -- and a later flash that trusted that handle
    // would decide a run was already going and quietly do nothing.
    if (this.flashTimer) global.cancelAnimationFrame(this.flashTimer);
    var self = this;
    var step = function () {
      var t = ((global.performance || Date).now() - self.flashAt) / self.FLASH_MS;
      if (t >= 1 || !self.flashRef) {
        self.flashRef = null;
        self.flashTimer = null;
        self.draw();
        return;
      }
      self.draw();
      self.flashTimer = global.requestAnimationFrame(step);
    };
    self.flashTimer = global.requestAnimationFrame(step);
  };

  Viewer.prototype.FLASH_MS = 600;

  Viewer.prototype.eventPos = function (e) {
    var rect = this.canvas.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top];
  };

  Viewer.prototype.onWheel = function (e) {
    e.preventDefault();
    var factor = Math.pow(1.0015, -e.deltaY * (e.deltaMode === 1 ? 16 : 1));
    this.zoomAt(this.eventPos(e), factor);
  };

  Viewer.prototype.onPointerDown = function (e) {
    // Only the primary button starts a gesture. A right press opens the
    // context menu, and on some platforms the menu swallows the matching
    // pointerup -- a drag begun here would then keep panning with no button
    // held. A middle press has no meaning on the board either way.
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    var pos = this.eventPos(e);
    if (e.pointerType === 'touch') this.touchPoints[e.pointerId] = pos;
    // A third finger has no role in any gesture here.
    if (this.pinch) return;
    // A second finger during a drag. Over a plain touch pan the pair becomes
    // a pinch; over an editor gesture it is ignored, so it cannot yank a
    // marker around by the distance between the fingers. A drag whose own
    // pointer is no longer down -- a missed pointerup after a failed capture
    // -- is stale, and falls through to be replaced like any dead gesture;
    // so does a reused pointerId, which would otherwise pinch with itself.
    if (this.dragging && e.pointerType === 'touch' &&
        e.pointerId !== this.dragging.pointerId &&
        this.touchPoints[this.dragging.pointerId]) {
      if (this.dragging.claimed) return;
      var first = this.touchPoints[this.dragging.pointerId];
      this.pinch = {
        a: this.dragging.pointerId, b: e.pointerId,
        dist: Math.hypot(pos[0] - first[0], pos[1] - first[1]),
        mid: [(pos[0] + first[0]) / 2, (pos[1] + first[1]) / 2]
      };
      this.dragging = null;
      try {
        this.canvas.setPointerCapture(e.pointerId);
      } catch (err) { /* the pinch just stops at the edge */ }
      return;
    }
    var hit = this.hitTest(pos);
    // A hook may claim the press -- the editor does, to drag a marker instead
    // of the board. The gesture still has to be tracked here, because the
    // move and up events that carry it out arrive on this canvas: claiming the
    // press means "do not pan", not "do not follow the pointer".
    var claimed = !!(this.opts.onPointerDown && this.opts.onPointerDown(e, pos, hit) === true);
    // Capture keeps a drag alive when the pointer leaves the canvas. It throws
    // if the pointer is already gone, and letting that escape would abort the
    // handler and leave the gesture untracked, so the drag matters more than
    // the capture.
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch (err) { /* drag still works, it just stops at the edge */ }
    this.dragging = { start: pos, tx: this.tx, ty: this.ty, moved: false,
                      hit: hit, claimed: claimed, pointerId: e.pointerId };
  };

  Viewer.prototype.onPointerMove = function (e) {
    var pos = this.eventPos(e);
    this.pointer = pos;
    if (e.pointerType === 'touch' && this.touchPoints[e.pointerId]) {
      this.touchPoints[e.pointerId] = pos;
    }
    if (this.pinch) {
      if (e.pointerId !== this.pinch.a && e.pointerId !== this.pinch.b) return;
      var pa = this.touchPoints[this.pinch.a];
      var pb = this.touchPoints[this.pinch.b];
      if (!pa || !pb) return;
      var dist = Math.hypot(pb[0] - pa[0], pb[1] - pa[1]);
      var mid = [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2];
      // Scale about the old midpoint by the change in finger separation, then
      // carry the view along with the midpoint: the patch of board between
      // the fingers stays between the fingers, which is the whole gesture.
      if (this.pinch.dist > 0 && dist > 0) {
        this.zoomAt(this.pinch.mid, dist / this.pinch.dist);
      }
      this.tx += mid[0] - this.pinch.mid[0];
      this.ty += mid[1] - this.pinch.mid[1];
      this.pinch.dist = dist;
      this.pinch.mid = mid;
      this.applyLayerTransforms();
      this.draw();
      return;
    }
    if (this.dragging) {
      // The drag belongs to one pointer; another finger resting on the screen
      // must not steer it.
      if (e.pointerId !== this.dragging.pointerId) return;
      // The context-menu case above is the belt; this is the braces. However
      // a mouse drag lost its button-up, a move that arrives with no buttons
      // down is not part of any drag.
      if (e.pointerType === 'mouse' && e.buttons === 0) {
        this.dragging = null;
      } else {
        var dx = pos[0] - this.dragging.start[0];
        var dy = pos[1] - this.dragging.start[1];
        if (Math.abs(dx) + Math.abs(dy) > 3) this.dragging.moved = true;
        if (this.opts.onDrag && this.opts.onDrag(this.dragging, pos) === true) {
          this.draw();
          return;
        }
        this.tx = this.dragging.tx + dx;
        this.ty = this.dragging.ty + dy;
        this.applyLayerTransforms();
        this.draw();
        return;
      }
    }
    var hit = this.hitTest(pos);
    if (this.opts.onHover) this.opts.onHover(hit, pos);
    var cursor = hit ? 'pointer' : 'grab';
    // The editor shows what a press would do here -- a resize arrow on a
    // handle, a move cursor inside the selection.
    if (this.opts.cursorFor) cursor = this.opts.cursorFor(pos, hit, cursor) || cursor;
    this.canvas.style.cursor = cursor;
    this.draw();
  };

  Viewer.prototype.onPointerUp = function (e) {
    if (e.pointerType === 'touch') delete this.touchPoints[e.pointerId];
    if (this.canvas.hasPointerCapture && this.canvas.hasPointerCapture(e.pointerId)) {
      this.canvas.releasePointerCapture(e.pointerId);
    }
    if (this.pinch) {
      if (e.pointerId !== this.pinch.a && e.pointerId !== this.pinch.b) return;
      // One finger has come off, so the pinch is over and the finger still on
      // the glass carries straight on as a pan. It is born already "moved":
      // lifting it must not read as a click on whatever it rests over, and a
      // pinch was never anybody's press to claim.
      var otherId = e.pointerId === this.pinch.a ? this.pinch.b : this.pinch.a;
      var rest = this.touchPoints[otherId];
      this.pinch = null;
      if (rest) {
        this.dragging = { start: rest, tx: this.tx, ty: this.ty, moved: true,
                          hit: null, claimed: false, pointerId: otherId };
      }
      return;
    }
    // A pointer that never owned the gesture -- a spare finger resting on the
    // screen -- has nothing to end, and must not end someone else's drag.
    if (this.dragging && e.pointerId !== this.dragging.pointerId) return;
    var drag = this.dragging;
    this.dragging = null;
    if (this.opts.onPointerUp) this.opts.onPointerUp(e, drag);
    // A cancelled gesture is not a click. pointercancel arrives when the
    // browser takes the pointer away -- palm rejection, a touch turning into a
    // scroll, the window losing focus -- and such a press has by definition not
    // moved, so without this it selects whatever happened to be underneath it.
    if (e && e.type === 'pointercancel') return;
    // A claimed press was somebody else's gesture; it does not also count as a
    // click here, or placing a part would immediately re-select something.
    if (drag && !drag.moved && !drag.claimed && this.opts.onClick) {
      this.opts.onClick(drag.hit, this.eventPos(e), e);
    }
  };

  /* ---- items and hit testing ------------------------------------------- */

  /**
   * Give the viewer the list of placeable things for the current space.
   * Each entry: {ref, item, x, y, w, h, shape}. Items without coordinates are
   * simply not passed in.
   */
  Viewer.prototype.setItems = function (items) {
    this.items = items || [];
    this.draw();
  };

  Viewer.prototype.setVerdicts = function (map) {
    this.verdicts = map || {};
    this.draw();
  };

  Viewer.prototype.hitTest = function (pos) {
    var best = null, bestArea = Infinity;
    for (var i = 0; i < this.items.length; i++) {
      var it = this.items[i];
      var box = this.screenBox(it);
      if (pos[0] < box.x || pos[0] > box.x + box.w) continue;
      if (pos[1] < box.y || pos[1] > box.y + box.h) continue;
      var area = box.w * box.h;
      if (area < bestArea) { best = it; bestArea = area; }
    }
    return best;
  };

  Viewer.prototype.screenBox = function (it) {
    var w = it.w || 0, h = it.h || 0;
    var tl = this.spaceToScreen(it.x - w / 2, it.y - h / 2);
    var br = this.spaceToScreen(it.x + w / 2, it.y + h / 2);
    // Below a few pixels a marker becomes both invisible and unclickable, so
    // every marker keeps a minimum on-screen size -- but a generous floor at
    // whole-board zoom turns 250 markers into a solid block, so it is modest
    // until there is room.
    var minSize = this.opts.minMarker || 9;
    var bw = Math.max(minSize, br[0] - tl[0]);
    var bh = Math.max(minSize, br[1] - tl[1]);
    var c = this.spaceToScreen(it.x, it.y);
    return { x: c[0] - bw / 2, y: c[1] - bh / 2, w: bw, h: bh, cx: c[0], cy: c[1] };
  };

  /* ---- drawing --------------------------------------------------------- */

  Viewer.prototype.draw = function () {
    if (!this.ctx || !this.width) return;
    var ctx = this.ctx;
    ctx.clearRect(0, 0, this.width, this.height);
    var style = this.opts.style || {};
    var state = BE.state;
    var highlighted = {};
    (state.highlighted || []).forEach(function (r) { highlighted[r] = true; });

    for (var i = 0; i < this.items.length; i++) {
      var it = this.items[i];
      var box = this.screenBox(it);
      if (box.x + box.w < -40 || box.x > this.width + 40) continue;
      if (box.y + box.h < -40 || box.y > this.height + 40) continue;

      var ref = it.ref;
      var isSel = state.selected === ref;
      var isHot = state.hovered === ref;
      var isHi = !!highlighted[ref];
      var verdict = this.verdicts[ref];
      var dim = state.highlighted && state.highlighted.length && !isHi && !isSel;

      // A marker keeps its own colour when highlighted -- the colour says what
      // the part is, which is exactly what a "show me all the zeners" filter
      // wants preserved. Being in the highlighted set reads as a heavier
      // stroke, with everything else dimmed around it.
      var color = it.color || style.marker || '#5b9dd9';
      if (verdict === 'pass') color = '#3fa96b';
      else if (verdict === 'marginal') color = '#d8a33a';
      else if (verdict === 'fail') color = '#d1495b';
      if (isSel) color = style.selected || '#ff7a45';

      ctx.save();
      ctx.globalAlpha = dim ? 0.18 : 1;
      ctx.lineWidth = isSel || isHot ? 2.5 : (isHi ? 2.2 : 1.6);
      ctx.strokeStyle = color;
      ctx.fillStyle = color;

      if (it.unverified) ctx.setLineDash([4, 3]);

      var pad = isSel || isHot ? 3 : 1;
      this.strokeShape(ctx, it.shape, box, pad);

      if (isSel || isHot || isHi) {
        ctx.globalAlpha = dim ? 0.1 : 0.16;
        this.fillShape(ctx, it.shape, box, pad);
        ctx.globalAlpha = dim ? 0.18 : 1;
      }

      // Labels only once there is room for them: at whole-board zoom 250 of
      // them would bury the drawing they are meant to annotate.
      var zoom = this.scale / (this.fitScale || this.scale);
      if (isSel || isHot || (zoom > 2.6 && !dim)) {
        ctx.setLineDash([]);
        ctx.font = '600 11px ui-monospace, SFMono-Regular, Menlo, monospace';
        var text = it.label || ref;
        var tw = ctx.measureText(text).width;
        var lx = box.cx - tw / 2, ly = box.y - 6;
        if (ly < 12) ly = box.y + box.h + 14;
        ctx.globalAlpha = dim ? 0.25 : 0.92;
        ctx.fillStyle = style.labelBg || 'rgba(16,18,22,0.86)';
        ctx.fillRect(lx - 4, ly - 11, tw + 8, 15);
        ctx.fillStyle = color;
        ctx.fillText(text, lx, ly);
      }
      ctx.restore();
    }

    // The locator goes on top of everything, so pointing at a part in a list
    // finds it on the board without disturbing the view.
    // The locating pulse, drawn after the markers so it sits over them. It is a
    // ring that grows outward from the marker and fades as it goes: motion is
    // what the eye catches on a crowded board, and a static change of colour is
    // exactly what it does not.
    if (this.flashRef) {
      var age = ((global.performance || Date).now() - this.flashAt) / this.FLASH_MS;
      // Expiring here, in the draw, rather than only in the animation loop: a
      // background tab does not run animation frames at all, so a pulse started
      // there would otherwise still be "running" when the tab came back.
      if (age > 1) {
        this.flashRef = null;
        if (this.flashTimer) {
          global.cancelAnimationFrame(this.flashTimer);
          this.flashTimer = null;
        }
      }
      if (age >= 0 && age <= 1) {
        for (var f = 0; f < this.items.length; f++) {
          if (this.items[f].ref !== this.flashRef) continue;
          var fb = this.screenBox(this.items[f]);
          var cx = fb.x + fb.w / 2, cy = fb.y + fb.h / 2;
          var round = this.items[f].shape === 'circle';
          var base = Math.max(fb.w, fb.h) / 2;
          ctx.save();
          // Two rings a beat apart, so there is a second chance to catch it,
          // and a dark outline under each -- a single thin ring disappears into
          // a dense schematic, which is exactly where it is needed most.
          for (var k = 0; k < 2; k++) {
            var t = age - k * 0.22;
            if (t <= 0 || t >= 1) continue;
            var e = 1 - Math.pow(1 - t, 2);            // fast first, then settle
            var grow = 16 + e * 44;
            var fade = (1 - t) * (k ? 0.5 : 0.95);
            var path = function (pad) {
              ctx.beginPath();
              if (round) {
                ctx.arc(cx, cy, base + grow + pad, 0, Math.PI * 2);
              } else {
                var rw = fb.w / 2 + grow + pad, rh = fb.h / 2 + grow + pad;
                ctx.rect(cx - rw, cy - rh, rw * 2, rh * 2);
              }
            };
            ctx.globalAlpha = fade * 0.55;
            ctx.strokeStyle = '#000';
            ctx.lineWidth = 6.5;
            path(0); ctx.stroke();
            ctx.globalAlpha = fade;
            ctx.strokeStyle = style.selected || '#ff7a45';
            ctx.lineWidth = 3;
            path(0); ctx.stroke();
          }
          // And a soft disc over the part itself for the first instant, so the
          // eye is told where to land as well as where the rings came from.
          if (age < 0.45) {
            ctx.globalAlpha = (1 - age / 0.45) * 0.28;
            ctx.fillStyle = style.selected || '#ff7a45';
            ctx.beginPath();
            ctx.arc(cx, cy, base + 10, 0, Math.PI * 2);
            ctx.fill();
          }
          ctx.restore();
          break;
        }
      }
    }

    if (state.hovered) {
      for (var h = 0; h < this.items.length; h++) {
        if (this.items[h].ref === state.hovered) {
          this.drawLocator(ctx, this.items[h]);
          break;
        }
      }
    }

    if (this.opts.afterDraw) this.opts.afterDraw(ctx, this);
  };

  /**
   * Mark one item emphatically without moving the view.
   *
   * Leaving the zoom alone means the thing being pointed at may be outside the
   * viewport, so when it is, an arrow at the edge says which way it lies
   * instead of silently highlighting nothing.
   */
  Viewer.prototype.drawLocator = function (ctx, it) {
    var box = this.screenBox(it);
    // A fixed colour rather than the item's own: type colours include pale
    // greys that vanish against the white drawing, and the whole point of the
    // locator is to be found immediately. Amber carries no other meaning on
    // the board -- selection is orange, and a marginal reading is only ever
    // amber inside the log panel.
    var color = '#ffb020';
    var margin = 42;   // clear of the coverage badge in the top corner
    // On screen means any of the marker's box, not its centre: a large marker
    // whose centre sits just past the edge is still in front of the reader,
    // and an "off screen" arrow over a part they are looking at points at
    // nothing -- while the partly visible reticle it displaced would help.
    var visible = box.x + box.w > 0 && box.x < this.width &&
                  box.y + box.h > 0 && box.y < this.height;

    ctx.save();
    ctx.lineCap = 'round';

    if (visible) {
      var radius = Math.max(box.w, box.h) / 2 + 12;
      // A dark halo under the bright stroke keeps the ring legible on the
      // white drawing and on the dark photograph alike.
      strokePass(ctx, 6, 'rgba(0,0,0,0.55)', function () { reticle(ctx, box.cx, box.cy, radius); });
      strokePass(ctx, 2.6, color, function () { reticle(ctx, box.cx, box.cy, radius); });
    } else {
      var x = Math.max(margin, Math.min(this.width - margin, box.cx));
      var y = Math.max(margin, Math.min(this.height - margin, box.cy));
      var angle = Math.atan2(box.cy - y, box.cx - x);

      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(angle);
      ctx.beginPath();
      ctx.moveTo(16, 0);
      ctx.lineTo(-6, -9);
      ctx.lineTo(-6, 9);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.strokeStyle = 'rgba(0,0,0,0.55)';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fill();
      ctx.restore();

      // The label is placed in canvas coordinates, not the arrow's rotated
      // frame, so it can be kept inside the viewport however the arrow points.
      ctx.font = '600 11px ui-monospace, SFMono-Regular, Menlo, monospace';
      var text = it.ref + ' · off screen';
      var w = ctx.measureText(text).width;
      var lx = Math.max(w / 2 + 8, Math.min(this.width - w / 2 - 8, x));
      var ly = y < this.height / 2 ? y + 26 : y - 18;
      ctx.fillStyle = 'rgba(16,18,22,0.92)';
      ctx.fillRect(lx - w / 2 - 5, ly - 11, w + 10, 15);
      ctx.fillStyle = color;
      ctx.fillText(text, lx - w / 2, ly);
    }
    ctx.restore();
  };

  function strokePass(ctx, width, style, path) {
    ctx.lineWidth = width;
    ctx.strokeStyle = style;
    path();
  }

  /** A ring with four ticks outside it — reads as "here" at a glance. */
  function reticle(ctx, cx, cy, r) {
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
    var inner = r + 4, outer = r + 11;
    ctx.beginPath();
    ctx.moveTo(cx, cy - inner); ctx.lineTo(cx, cy - outer);
    ctx.moveTo(cx, cy + inner); ctx.lineTo(cx, cy + outer);
    ctx.moveTo(cx - inner, cy); ctx.lineTo(cx - outer, cy);
    ctx.moveTo(cx + inner, cy); ctx.lineTo(cx + outer, cy);
    ctx.stroke();
  }

  Viewer.prototype.strokeShape = function (ctx, shape, box, pad) {
    this.pathShape(ctx, shape, box, pad);
    ctx.stroke();
  };

  Viewer.prototype.fillShape = function (ctx, shape, box, pad) {
    this.pathShape(ctx, shape, box, pad);
    ctx.fill();
  };

  Viewer.prototype.pathShape = function (ctx, shape, box, pad) {
    var x = box.x - pad, y = box.y - pad;
    var w = box.w + pad * 2, h = box.h + pad * 2;
    ctx.beginPath();
    if (shape === 'circle') {
      ctx.ellipse(box.cx, box.cy, w / 2, h / 2, 0, 0, Math.PI * 2);
    } else if (shape === 'point') {
      ctx.ellipse(box.cx, box.cy, Math.min(w, h) / 2, Math.min(w, h) / 2, 0, 0, Math.PI * 2);
    } else {
      var r = Math.min(4, w / 4, h / 4);
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    }
  };

  global.Viewer = Viewer;
})(window);
