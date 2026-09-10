/*
 * snap.js — pull a hand-drawn outline onto the outline printed underneath it.
 *
 * Sweeping a box by hand gets you within a few percent; the drawing knows
 * exactly where the part is. So after a shape is drawn, the pixels inside a
 * small search band around it are read back and the shape is fitted to the ink
 * found there. It is allowed to move each boundary by at most TOLERANCE of the
 * drawn size, which keeps a snap a correction rather than a relocation: if the
 * right answer is further away than that, the hand-drawn shape was wrong in a
 * way no amount of fitting should paper over.
 *
 * Two things this deliberately will not do:
 *
 *   - It will not read a photograph. A component on the board drawing is a
 *     closed outline in ink on paper; the same component in a photograph is a
 *     grey object on a green board under uneven light, with its own printing,
 *     its neighbours' shadows and a solder mask that is darker than some parts
 *     and lighter than others. An edge finder that works on the first is not
 *     merely less accurate on the second, it is confidently wrong. So the
 *     search runs against the line art only, and only while the line art is
 *     what is on screen.
 *
 *   - It will not guess. Every fit has to clear an agreement threshold before
 *     it is used, and a region that is not clearly ink-on-paper is declined
 *     outright. A refusal costs a hand adjustment; a bad snap costs a marker
 *     silently moved onto the neighbouring part, which is the failure the
 *     containment check exists to catch after the fact.
 *
 * Reading pixels needs getImageData, and a canvas that has had a file:// image
 * drawn into it is tainted, so this is unavailable when the page is opened
 * straight off disk. Everything else in Author Mode still works; serve the
 * directory to get snapping back.
 */
(function (global) {
  'use strict';

  var TOLERANCE = 0.15;     // how far a boundary may move, as a fraction of size
  // The search looks further than the fit is allowed to move, because an
  // outline 15% away from a shape whose centre is also 15% out is more than
  // 15% away along some directions, and a finder that cannot see the edge it
  // is meant to reject will instead find something else and report success.
  // Anything found beyond TOLERANCE is declined, never dragged back to it: a
  // shape clamped to the limit is neither what was drawn nor what is printed.
  var SEARCH = 0.30;
  var RAYS = 64;            // directions cast when fitting a circle
  var MIN_HIT_RATE = 0.6;   // rays that must find ink before a circle is trusted
  var MAX_RMS = 0.08;       // residual of the circle fit, as a fraction of radius
  var MIN_EDGE = 0.5;       // of a box side's length that must be ink
  var MIN_SPREAD = 40;      // luminance between paper and ink, out of 255
  var MAX_INK = 0.45;       // above this the region is not line art
  var MAX_PIXELS = 4e6;     // a search window bigger than this is not worth it

  // Line art only, and only while it is the thing on screen. 'overlay' and
  // 'swipe' put the photograph over the drawing, so what you aimed at is not
  // what would be measured.
  var LINE_ART = { drawing: true, schematic: true, split: true };

  var Snap = {};

  /** Why snapping cannot run right now, or null when it can. */
  Snap.unavailable = function (viewer) {
    var display = global.BoardExplorer.state.display;
    if (display && !LINE_ART[display]) {
      return 'the photograph is on screen — snapping reads the drawing';
    }
    if (!baseLayer(viewer)) return 'the drawing has not loaded yet';
    if (tainted === true) return 'the page is open from a file:// path';
    return null;
  };

  /**
   * Fit `geom` to the ink around it. Returns a new geometry and a note on what
   * changed, or null if nothing convincing was found and the drawn shape
   * should stand.
   */
  Snap.refine = function (viewer, geom) {
    if (Snap.unavailable(viewer)) return null;
    var layer = baseLayer(viewer);
    var W = layer.natural.w, H = layer.natural.h;

    // Everything is measured in image pixels, where a circle is a circle:
    // normalised space stretches x and y differently.
    var box = {
      cx: geom.x * W, cy: geom.y * H,
      w: geom.w * W, h: geom.h * H
    };
    var padX = Math.max(3, box.w * SEARCH);
    var padY = Math.max(3, box.h * SEARCH);
    var field = read(layer,
      box.cx - box.w / 2 - padX, box.cy - box.h / 2 - padY,
      box.cx + box.w / 2 + padX, box.cy + box.h / 2 + padY);
    if (!field) return null;

    var fitted = geom.shape === 'rect'
      ? fitRect(field, box, Math.max(2, box.w * TOLERANCE), Math.max(2, box.h * TOLERANCE))
      : fitRound(field, box);
    if (!fitted) return null;

    var out = { x: fitted.cx / W, y: fitted.cy / H,
                w: fitted.w / W, h: fitted.h / H, shape: geom.shape };
    // A fit that lands where the shape already was is still a fit, and has to
    // be reported as one: returning null here would be indistinguishable from
    // finding nothing, and the caller would announce a refusal that never
    // happened. It simply has nothing to say about it.
    var shift = Math.hypot(fitted.cx - box.cx, fitted.cy - box.cy);
    var grow = Math.max(Math.abs(fitted.w - box.w), Math.abs(fitted.h - box.h));
    var negligible = shift < 0.75 && grow < 0.75;
    return { geom: out, note: negligible ? null : describe(box, fitted) };
  };

  function describe(before, after) {
    var shift = Math.hypot(after.cx - before.cx, after.cy - before.cy);
    var pct = before.w ? Math.round((after.w / before.w - 1) * 100) : 0;
    return 'snapped to the outline — moved ' + shift.toFixed(0) + ' px' +
      (pct ? ', size ' + (pct > 0 ? '+' : '') + pct + '%' : '');
  }

  /* ---- getting at the pixels ---- */

  var tainted = null;       // null until the first read tells us

  function baseLayer(viewer) {
    if (!viewer || !viewer.layers) return null;
    var ids = Object.keys(viewer.layers);
    for (var i = 0; i < ids.length; i++) {
      var rec = viewer.layers[ids[i]];
      var t = rec.def && rec.def.transform;
      if (rec.natural && (!t || t === 'identity')) return rec;
    }
    return null;
  }

  /**
   * Luminance for a rectangle of the source image, plus an ink test.
   *
   * The threshold is found by Otsu's method rather than assumed, and which
   * side of it counts as ink is decided by which side is rarer. The board
   * drawing is dark on light and the app shows it inverted, and a reader that
   * has an opinion about which is which will one day meet the other one.
   */
  function read(layer, x0, y0, x1, y1) {
    var W = layer.natural.w, H = layer.natural.h;
    x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0));
    x1 = Math.min(W, Math.ceil(x1));  y1 = Math.min(H, Math.ceil(y1));
    var w = x1 - x0, h = y1 - y0;
    if (w < 4 || h < 4 || w * h > MAX_PIXELS) return null;

    var canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    var ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(layer.img, x0, y0, w, h, 0, 0, w, h);
    var raw;
    try {
      raw = ctx.getImageData(0, 0, w, h).data;
    } catch (err) {
      tainted = true;       // file:// — say so once, then stop offering
      return null;
    }
    tainted = false;

    var lum = new Uint8Array(w * h);
    var hist = new Uint32Array(256);
    for (var i = 0, p = 0; i < lum.length; i++, p += 4) {
      var v = (raw[p] * 77 + raw[p + 1] * 151 + raw[p + 2] * 28) >> 8;
      lum[i] = v;
      hist[v]++;
    }
    if (spread(hist, lum.length) < MIN_SPREAD) return null;

    var t = otsu(hist, lum.length);
    var dark = 0;
    for (var j = 0; j < lum.length; j++) if (lum[j] <= t) dark++;
    var darkIsInk = dark <= lum.length - dark;
    var inkCount = darkIsInk ? dark : lum.length - dark;
    // Ink is what the lines are made of. If nearly half the window is "ink"
    // this is not a line drawing of anything -- it is a filled region, or a
    // photograph, and every edge in it would score well.
    if (inkCount / lum.length > MAX_INK) return null;

    var ink = new Uint8Array(w * h);
    for (var k = 0; k < lum.length; k++) {
      ink[k] = (darkIsInk ? lum[k] <= t : lum[k] > t) ? 1 : 0;
    }
    return { ink: ink, w: w, h: h, x0: x0, y0: y0,
             at: function (x, y) {
               x = Math.round(x) - x0; y = Math.round(y) - y0;
               if (x < 0 || y < 0 || x >= w || y >= h) return 0;
               return ink[y * w + x];
             } };
  }

  /** Distance between the 5th and 95th percentile of a luminance histogram. */
  function spread(hist, total) {
    var lo = 0, hi = 255, seen = 0, i;
    for (i = 0; i < 256; i++) { seen += hist[i]; if (seen >= total * 0.05) { lo = i; break; } }
    seen = 0;
    for (i = 255; i >= 0; i--) { seen += hist[i]; if (seen >= total * 0.05) { hi = i; break; } }
    return hi - lo;
  }

  /** Otsu's threshold: the split that best separates the histogram in two. */
  function otsu(hist, total) {
    var sum = 0, i;
    for (i = 0; i < 256; i++) sum += i * hist[i];
    var sumB = 0, wB = 0, best = 0, bestVar = -1;
    for (i = 0; i < 256; i++) {
      wB += hist[i];
      if (!wB) continue;
      var wF = total - wB;
      if (!wF) break;
      sumB += i * hist[i];
      var mB = sumB / wB, mF = (sum - sumB) / wF;
      var between = wB * wF * (mB - mF) * (mB - mF);
      if (between > bestVar) { bestVar = between; best = i; }
    }
    return best;
  }

  /* ---- fitting ---- */

  /**
   * Move each side of the box onto the strongest straight run of ink near it.
   *
   * A side is scored by how much of its own length is ink, sampled across the
   * middle 80% so that a corner, or a designator printed against one end,
   * cannot carry a side on its own. Sides are scored independently: three good
   * ones and a fourth that finds nothing leave that fourth where it was drawn.
   */
  function fitRect(field, box, padX, padY) {
    var left = box.cx - box.w / 2, right = box.cx + box.w / 2;
    var top = box.cy - box.h / 2, bottom = box.cy + box.h / 2;
    var inset = 0.1;
    var y0 = top + box.h * inset, y1 = bottom - box.h * inset;
    var x0 = left + box.w * inset, x1 = right - box.w * inset;

    var l = bestLine(field, left, padX, y0, y1, true);
    var r = bestLine(field, right, padX, y0, y1, true);
    var t = bestLine(field, top, padY, x0, x1, false);
    var b = bestLine(field, bottom, padY, x0, x1, false);
    if (l == null && r == null && t == null && b == null) return null;

    left = l == null ? left : l;
    right = r == null ? right : r;
    top = t == null ? top : t;
    bottom = b == null ? bottom : b;
    if (right - left < 2 || bottom - top < 2) return null;
    return { cx: (left + right) / 2, cy: (top + bottom) / 2,
             w: right - left, h: bottom - top };
  }

  /**
   * The nearest solid line within ±pad of `at`, or null if there is none.
   *
   * Nearest, not strongest. Every line that clears MIN_EDGE is a real printed
   * line, so picking the boldest one among them means a heavy neighbouring
   * trace can outvote the component's own outline two pixels from where the
   * edge was drawn. The threshold decides what counts as a line; proximity to
   * what was aimed at decides which line was meant.
   */
  function bestLine(field, at, pad, from, to, vertical) {
    var span = Math.max(1, Math.round(to - from));
    var reach = Math.round(pad);
    for (var d = 0; d <= reach; d++) {
      // Outwards from the drawn edge, both ways, nearest first.
      for (var side = 0; side < (d ? 2 : 1); side++) {
        var pos = at + (side ? -d : d), hits = 0;
        for (var s = 0; s <= span; s++) {
          var along = from + s;
          if (field.at(vertical ? pos : along, vertical ? along : pos)) hits++;
        }
        if (hits / (span + 1) >= MIN_EDGE) return pos;
      }
    }
    return null;
  }

  /**
   * Fit a circle by casting rays out from the centre and looking for the ink
   * crossing nearest the drawn radius.
   *
   * For a circle of radius R offset by (dx, dy) from where the rays start, the
   * crossing along direction θ is R + dx·cosθ + dy·sinθ to first order — and
   * first order is all that is needed, because the offset is never allowed to
   * exceed 15%. So the three unknowns come straight out of a least-squares
   * solve over all the rays, with no iteration and nothing to converge.
   */
  function fitRound(field, box) {
    var R0 = Math.min(box.w, box.h) / 2;
    if (R0 < 3) return null;
    var lo = R0 * (1 - SEARCH), hi = R0 * (1 + SEARCH);
    var cx = box.cx, cy = box.cy, R = R0;

    // Three passes, because the first one is answering the wrong question.
    // Rays cast from an off-centre point cross the same ring at different
    // radii depending on direction, so the radius that comes back is a blur
    // over that spread; the offset, though, comes back well, being exactly the
    // cosine term the model has a name for. Move to the corrected centre and
    // ask again and the spread collapses, and the third pass has nothing left
    // to do -- which is the point at which the radius can be believed.
    var picked = null;
    for (var pass = 0; pass < 3; pass++) {
      picked = cast(field, cx, cy, lo, hi, R);
      if (picked.rad.length < RAYS * MIN_HIT_RATE) return null;
      var fit = solve3(picked.cos, picked.sin, picked.rad);
      if (!fit) return null;
      R = fit[0]; cx += fit[1]; cy += fit[2];
      if (R < 3) return null;
    }

    // Judged on the last cast, where the model is a plain circle: how many
    // rays actually landed on it, and how far off the ones that did.
    picked = cast(field, cx, cy, lo, hi, R);
    var near = 0, err = 0;
    var slack = Math.max(1.5, R * 0.025);
    for (var k = 0; k < picked.rad.length; k++) {
      var d = picked.rad[k] - R;
      err += d * d;
      if (Math.abs(d) <= slack) near++;
    }
    if (near < RAYS * MIN_HIT_RATE) return null;
    if (!picked.rad.length || Math.sqrt(err / picked.rad.length) > MAX_RMS * R) return null;

    // The fence. Beyond it the outline underneath is not a correction to what
    // was drawn but a different shape, and the drawn one stands.
    var limit = R0 * TOLERANCE;
    if (Math.hypot(cx - box.cx, cy - box.cy) > limit) return null;
    if (Math.abs(R - R0) > limit) return null;
    // A round marker is square in image pixels; the caller normalises it back
    // into a space where the two axes have different scales.
    return { cx: cx, cy: cy, w: R * 2, h: R * 2 };
  }

  /** Ink crossings around a centre, one per ray, nearest to radius `R`. */
  function cast(field, cx, cy, lo, hi, R) {
    var cos = [], sin = [], rad = [];
    for (var i = 0; i < RAYS; i++) {
      var a = i * 2 * Math.PI / RAYS;
      var ca = Math.cos(a), sa = Math.sin(a);
      var pick = null, wasInk = 0;
      for (var r = lo; r <= hi; r += 0.5) {
        var ink = field.at(cx + ca * r, cy + sa * r);
        // The near edge of a stroke, not every pixel of it: a 3 px line would
        // otherwise contribute three crossings and weight itself triple.
        if (ink && !wasInk && (pick == null || Math.abs(r - R) < Math.abs(pick - R))) pick = r;
        wasInk = ink;
      }
      if (pick == null) continue;
      cos.push(ca); sin.push(sa); rad.push(pick);
    }
    return { cos: cos, sin: sin, rad: rad };
  }

  /** Least squares for r ≈ a + b·cos + c·sin, by normal equations. */
  function solve3(cos, sin, rad) {
    var n = rad.length;
    var Scc = 0, Sss = 0, Scs = 0, Sc = 0, Ss = 0;
    var Sr = 0, Src = 0, Srs = 0;
    for (var i = 0; i < n; i++) {
      Scc += cos[i] * cos[i]; Sss += sin[i] * sin[i]; Scs += cos[i] * sin[i];
      Sc += cos[i]; Ss += sin[i];
      Sr += rad[i]; Src += rad[i] * cos[i]; Srs += rad[i] * sin[i];
    }
    var m = [[n, Sc, Ss], [Sc, Scc, Scs], [Ss, Scs, Sss]];
    var v = [Sr, Src, Srs];
    // Gaussian elimination with partial pivoting; three rows, so spelling it
    // out is shorter than anything general.
    for (var c = 0; c < 3; c++) {
      var p = c;
      for (var r2 = c + 1; r2 < 3; r2++) if (Math.abs(m[r2][c]) > Math.abs(m[p][c])) p = r2;
      if (Math.abs(m[p][c]) < 1e-9) return null;
      var tmp = m[c]; m[c] = m[p]; m[p] = tmp;
      var tv = v[c]; v[c] = v[p]; v[p] = tv;
      for (var r3 = 0; r3 < 3; r3++) {
        if (r3 === c) continue;
        var f = m[r3][c] / m[c][c];
        for (var k2 = c; k2 < 3; k2++) m[r3][k2] -= f * m[c][k2];
        v[r3] -= f * v[c];
      }
    }
    return [v[0] / m[0][0], v[1] / m[1][1], v[2] / m[2][2]];
  }

  Snap.TOLERANCE = TOLERANCE;
  global.Snap = Snap;
})(window);
