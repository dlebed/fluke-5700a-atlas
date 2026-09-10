/*
 * geom.js — the little bit of projective geometry the viewer needs.
 *
 * Everything in the app is authored in one normalised "board space", (0,0) at
 * the top-left of the board drawing and (1,1) at its bottom-right. A layer that
 * is not the drawing itself — the photograph — declares a 3x3 homography that
 * maps board space onto its own normalised image space. That single matrix is
 * what lets a component be placed once and highlighted correctly on the drawing,
 * on the photo, and on the two blended together.
 */
(function (global) {
  'use strict';

  var Geom = {};

  /* ---- 3x3 matrices, stored row-major as a flat array of 9 -------------- */

  Geom.IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];

  Geom.apply = function (m, x, y) {
    var w = m[6] * x + m[7] * y + m[8];
    if (!w) w = 1e-12;
    return [(m[0] * x + m[1] * y + m[2]) / w, (m[3] * x + m[4] * y + m[5]) / w];
  };

  Geom.multiply = function (a, b) {
    var out = new Array(9);
    for (var r = 0; r < 3; r++) {
      for (var c = 0; c < 3; c++) {
        out[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
      }
    }
    return out;
  };

  Geom.invert = function (m) {
    var a = m[0], b = m[1], c = m[2], d = m[3], e = m[4], f = m[5],
        g = m[6], h = m[7], i = m[8];
    var A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
    var det = a * A + b * B + c * C;
    if (Math.abs(det) < 1e-15) return null;
    return [
      A / det, (c * h - b * i) / det, (b * f - c * e) / det,
      B / det, (a * i - c * g) / det, (c * d - a * f) / det,
      C / det, (b * g - a * h) / det, (a * e - b * d) / det
    ];
  };

  /* ---- solving a homography from corresponding points ------------------ */

  // Gaussian elimination with partial pivoting on an n x (n+1) augmented matrix.
  function solveLinear(M, n) {
    for (var col = 0; col < n; col++) {
      var pivot = col;
      for (var r = col + 1; r < n; r++) {
        if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
      }
      if (Math.abs(M[pivot][col]) < 1e-12) return null;
      var tmp = M[col]; M[col] = M[pivot]; M[pivot] = tmp;
      for (var r2 = 0; r2 < n; r2++) {
        if (r2 === col) continue;
        var factor = M[r2][col] / M[col][col];
        for (var c2 = col; c2 <= n; c2++) M[r2][c2] -= factor * M[col][c2];
      }
    }
    var x = new Array(n);
    for (var k = 0; k < n; k++) x[k] = M[k][n] / M[k][k];
    return x;
  }

  /**
   * Least-squares homography mapping src points to dst points.
   * Needs at least 4 pairs; more pairs are averaged, which is how extra
   * landmarks tighten the photo alignment.
   *
   * pairs: [{src:[x,y], dst:[x,y]}, ...]
   */
  Geom.solveHomography = function (pairs) {
    if (!pairs || pairs.length < 4) return null;
    // Each pair contributes two rows to A h = b, with h the 8 free parameters
    // (the ninth is fixed at 1). The normal equations go straight into an
    // augmented matrix: A^T b rides along as column 8.
    var ata = [];
    for (var i = 0; i < 8; i++) {
      ata.push(new Array(9).fill(0));
    }
    pairs.forEach(function (p) {
      var x = p.src[0], y = p.src[1], u = p.dst[0], v = p.dst[1];
      var rows = [
        [x, y, 1, 0, 0, 0, -u * x, -u * y, u],
        [0, 0, 0, x, y, 1, -v * x, -v * y, v]
      ];
      rows.forEach(function (row) {
        for (var r = 0; r < 8; r++) {
          for (var c = 0; c < 8; c++) ata[r][c] += row[r] * row[c];
          ata[r][8] += row[r] * row[8];
        }
      });
    });
    var h = solveLinear(ata, 8);
    if (!h) return null;
    for (var k = 0; k < 8; k++) {
      if (!isFinite(h[k])) return null;
    }
    var H = [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
    // Landmarks along one line -- three points on a board edge is a natural
    // way to place them -- leave the system ill-conditioned rather than
    // singular, and it still "solves": to a matrix that flattens the plane
    // onto a line or a point while fitting the landmarks themselves closely
    // enough that the residuals read as a good alignment. Every caller treats
    // a returned matrix as one, so a collapsing matrix must not get out. It
    // has to be invertible, and the unit square's image under it has to keep
    // a real area on both sides of its diagonal -- a legitimate alignment
    // maps the board onto a substantial part of the photograph, never onto a
    // sliver thinner than a hundredth of a percent of it.
    if (!Geom.invert(H)) return null;
    var c00 = Geom.apply(H, 0, 0), c10 = Geom.apply(H, 1, 0),
        c11 = Geom.apply(H, 1, 1), c01 = Geom.apply(H, 0, 1);
    var area1 = (c10[0] - c00[0]) * (c11[1] - c00[1]) -
                (c11[0] - c00[0]) * (c10[1] - c00[1]);
    var area2 = (c11[0] - c00[0]) * (c01[1] - c00[1]) -
                (c01[0] - c00[0]) * (c11[1] - c00[1]);
    if (Math.abs(area1) < 1e-4 || Math.abs(area2) < 1e-4) return null;
    return H;
  };

  /** Per-pair residual in destination units, for judging a bad landmark. */
  Geom.residuals = function (m, pairs) {
    return pairs.map(function (p) {
      var q = Geom.apply(m, p.src[0], p.src[1]);
      return Math.hypot(q[0] - p.dst[0], q[1] - p.dst[1]);
    });
  };

  /* ---- CSS ------------------------------------------------------------- */

  /**
   * A 3x3 projective transform expressed as a CSS matrix3d, which is the only
   * way to get a browser to warp an <img> projectively. Assumes
   * transform-origin: 0 0.
   */
  Geom.toMatrix3d = function (m) {
    return 'matrix3d(' + [
      m[0], m[3], 0, m[6],
      m[1], m[4], 0, m[7],
      0, 0, 1, 0,
      m[2], m[5], 0, m[8]
    ].join(',') + ')';
  };

  /** Affine scale+translate as a 3x3, for the pan/zoom view transform. */
  Geom.viewMatrix = function (scale, tx, ty) {
    return [scale, 0, tx, 0, scale, ty, 0, 0, 1];
  };

  global.Geom = Geom;
})(window);
