/*
 * testpoints.js — what a test point should read, and whether a reading is good.
 *
 * The expectation for a point comes in one of three printed forms, and the
 * evaluator has to handle all of them because the manual mixes them freely:
 *
 *   nominal + tolerance      absolute volts,  "+17 SR ... 27V +/-8V"
 *   nominal + tolerancePct   percentage,      "TP209 ... +565 +/-10%"
 *   maxAbs                   a ceiling only,  "TP201 ... less than 1.0V"
 *
 * Rails that are only a return path carry no expectation at all, and the +/-PA
 * points carry a list of states because their correct reading depends on which
 * mode the supply has been jumpered into.
 */
(function (global) {
  'use strict';

  var TestPoints = {};

  /** The expectation objects a point offers: either its states, or itself. */
  TestPoints.states = function (tp) {
    if (!tp) return [];
    if (tp.states && tp.states.length) return tp.states;
    if (tp.isReturn) return [];
    if (tp.nominal == null && tp.maxAbs == null) return [];
    return [{
      label: tp.condition || 'Nominal',
      nominal: tp.nominal,
      tolerance: tp.tolerance,
      tolerancePct: tp.tolerancePct,
      maxAbs: tp.maxAbs,
      source: tp.source,
      onFail: tp.onFail
    }];
  };

  TestPoints.hasExpectation = function (tp) {
    return TestPoints.states(tp).length > 0;
  };

  /** Absolute limits for one state, or null when it has no expectation. */
  TestPoints.range = function (state) {
    if (!state) return null;
    if (state.maxAbs != null) {
      var base = state.nominal == null ? 0 : state.nominal;
      return { lo: base - state.maxAbs, hi: base + state.maxAbs, nominal: base,
               tol: state.maxAbs, kind: 'maxAbs' };
    }
    if (state.nominal == null) return null;
    var tol = state.tolerance;
    if (tol == null && state.tolerancePct != null) {
      tol = Math.abs(state.nominal) * state.tolerancePct / 100;
    }
    if (tol == null) return null;
    return { lo: state.nominal - tol, hi: state.nominal + tol,
             nominal: state.nominal, tol: tol,
             kind: state.tolerancePct != null ? 'pct' : 'abs' };
  };

  /**
   * Score a measurement.
   *
   * Green inside the inner half of the tolerance band, amber in the outer half,
   * red outside it. The inner band is deliberately not a second published
   * limit: it is a "this is drifting" hint, so a reading that the manual would
   * pass but that sits near the edge is still visibly different from one that
   * sits on nominal.
   */
  TestPoints.evaluate = function (state, measured) {
    var range = TestPoints.range(state);
    if (range == null || measured == null || isNaN(measured)) return null;
    var deviation = measured - range.nominal;
    // Percent off nominal is meaningless against a nominal of zero, which is
    // exactly the "should read less than 1 V" case, so report volts there.
    var pct = range.nominal === 0 ? null : (deviation / Math.abs(range.nominal)) * 100;
    var inRange = measured >= range.lo && measured <= range.hi;
    var margin = range.tol === 0 ? 1 : Math.abs(deviation) / range.tol;
    var verdict = !inRange ? 'fail' : (margin <= 0.5 ? 'pass' : 'marginal');
    return {
      verdict: verdict,
      measured: measured,
      nominal: range.nominal,
      lo: range.lo,
      hi: range.hi,
      tol: range.tol,
      deviation: deviation,
      pctOffNominal: pct,
      // How much of the allowed tolerance this reading uses up, 0..1+.
      usedTolerance: margin
    };
  };

  TestPoints.formatRange = function (state, unit) {
    var range = TestPoints.range(state);
    if (!range) return '—';
    var u = unit || 'V';
    // A ceiling around zero is a statement about the reading's magnitude, and
    // has to read as one: the limit gets no sign, because it is a bound, not a
    // level. A maxAbs curated against a nonzero nominal is an ordinary band
    // and falls through to the lo … hi form, which is what it actually means.
    if (range.kind === 'maxAbs' && range.nominal === 0) {
      return '|reading| ≤ ' + magnitude(range.tol) + ' ' + u;
    }
    var pct = state.tolerancePct != null ? ' (±' + state.tolerancePct + '%)' : '';
    return fmt(range.lo, range.tol) + ' … ' + fmt(range.hi, range.tol) + ' ' + u + pct;
  };

  TestPoints.formatNominal = function (state, unit) {
    var range = TestPoints.range(state);
    if (!range) return '—';
    // The nominal is signed because -565 V and +565 V are different places to
    // put a probe; the tolerance either side of it is not. The nominal also
    // may not print coarser than its own band: 1.2288 MHz ± 0.002 rounded to
    // "+1.23" disagrees with the tolerance beside it.
    return fmt(range.nominal, range.tol) + ' ' + (unit || 'V') + ' ± ' + magnitude(range.tol);
  };

  /**
   * Decimal places for a value — and, when the band around it is narrower than
   * the value's own print precision, for the band. 32 MHz held to ±0.1% is a
   * 0.032 MHz tolerance: printed to the whole-number precision the magnitude
   * alone would pick, both ends round to "+32" and the accept range reads as a
   * point. So the finer of the two magnitudes chooses, and below 1 the count
   * follows the leading significant digit rather than stopping at three,
   * capped so a degenerate tolerance cannot ask for a page of zeros.
   */
  function digitsFor(v, tol) {
    var a = Math.abs(v);
    if (tol != null && isFinite(tol) && tol > 0 && tol < a) a = tol;
    if (a >= 100) return 0;
    if (a >= 10) return 1;
    if (a >= 1) return 2;
    if (a === 0) return 3;
    return Math.max(3, Math.min(6, Math.ceil(-Math.log(a) / Math.LN10) + 1));
  }

  function trim(s) {
    return /\./.test(s) ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
  }

  function fmt(v, tol) {
    if (v == null) return '—';
    return (v > 0 ? '+' : '') + trim(v.toFixed(digitsFor(v, tol)));
  }

  function magnitude(v) {
    if (v == null) return '—';
    return trim(Math.abs(v).toFixed(digitsFor(v)));
  }

  TestPoints.fmt = fmt;
  TestPoints.magnitude = magnitude;

  /** Group the assembly's test points by supply rail, in a stable order. */
  TestPoints.byRail = function (dataset) {
    var rails = dataset.rails || {};
    var order = Object.keys(rails);
    var groups = {};
    (dataset.testpoints || []).forEach(function (tp) {
      var key = tp.rail || 'OTHER';
      (groups[key] = groups[key] || []).push(tp);
    });
    Object.keys(groups).forEach(function (key) {
      groups[key].sort(function (a, b) {
        // Returns last within a rail: the supplies are what you measure, the
        // return is what you clip the black lead to.
        if (!!a.isReturn !== !!b.isReturn) return a.isReturn ? 1 : -1;
        return numOf(a.ref) - numOf(b.ref);
      });
    });
    return order.filter(function (k) { return groups[k]; })
      .map(function (k) {
        return { id: k, label: (rails[k] || {}).label || k,
                 com: (rails[k] || {}).com, color: (rails[k] || {}).color,
                 testpoints: groups[k] };
      })
      .concat(groups.OTHER ? [{ id: 'OTHER', label: 'Other', testpoints: groups.OTHER }] : []);
  };

  function numOf(ref) {
    var m = /(\d+)$/.exec(ref || '');
    return m ? parseInt(m[1], 10) : 0;
  }

  global.TestPoints = TestPoints;
})(window);
