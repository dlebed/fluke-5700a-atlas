/*
 * caps.js — the capacitor voltage-derating audit.
 *
 * These calibrators are known for tantalums failing short, and the reason is
 * margin: Fluke fitted parts whose rated voltage sits close to the rail they
 * are on, and a solid tantalum run near its rating fails at a rate that only
 * derating fixes. MIL-HDBK-217 asks for 50% derating on solid tantalum; the
 * manufacturers agree on the same rule of thumb, and at 50% the predicted
 * failure rate drops about tenfold and MTTF goes from a few years to over a
 * hundred. So "applied over rated" is the number that matters, and this
 * computes it for every capacitor on the board.
 *
 * Two things it needs and cannot work out for itself:
 *
 *   rated voltage   read from the parts list, which states it for every
 *                   capacitor -- "CAP,TA,4.7UF,+-20%,25V".
 *   applied voltage which rail the part actually sits on. That is a schematic
 *                   question, curated per board into data/<asm>.caps.json,
 *                   and honestly marked as read-from-schematic or inferred.
 *
 * Either can be wrong -- a misread rating, a rail traced to the wrong net --
 * so both are editable in Author Mode and the override is kept beside the
 * dataset rather than in it.
 *
 * Ratio alone does not rank the risk, though. What a failing tantalum does
 * depends on what is behind it: a short across an unfused rail with a 6600 uF
 * reservoir behind a 3 A regulator is a fire, and the same short on a fused
 * 0.5 A rail blows the fuse. That is the rail class, and it belongs in the
 * ranking next to the margin.
 */
(function (global) {
  'use strict';

  var KEY = 'fluke5700a.capaudit.v1';

  /**
   * Where the bands come from.
   *
   * 50% is the industry rule for solid tantalum (MIL-HDBK-217, and every
   * manufacturer's application note says the same). The bands above it are the
   * owner's, from auditing this instrument: 65% is where A17's C13 sat when it
   * failed in service, which makes it the line worth drawing rather than an
   * arbitrary one.
   */
  var BANDS = [
    // Not a risk band. Fluke did not ship a tantalum sitting above its own
    // rating -- such a part fails on the first power-up, so the instrument
    // would never have left the factory working. A ratio over 1.0 therefore
    // means the data is wrong: the rail was traced to the wrong net, or the
    // rating was misread. It ranks first because it needs attention, but the
    // work it calls for is a correction, not a replacement.
    { id: 'error',    from: 1.00, label: 'Check data',
      hint: 'Above its own rating, which cannot be the original design — the rail or the rating is wrong' },
    { id: 'critical', from: 0.80, label: 'Critical',     hint: '80% or more of rated — replace' },
    { id: 'high',     from: 0.65, label: 'High',         hint: '65–80% of rated — replace' },
    { id: 'marginal', from: 0.50, label: 'Marginal',     hint: '50–65% of rated — replace if convenient' },
    { id: 'ok',       from: 0,    label: 'OK',           hint: 'Under 50% of rated — leave alone' }
  ];

  var UNKNOWN = { id: 'unknown', label: 'Unknown', hint: 'Rail not traced — verify before relying on this' };

  var RANK = { error: 0, critical: 1, high: 2, unknown: 3, marginal: 4, ok: 5 };

  var Caps = { BANDS: BANDS, UNKNOWN: UNKNOWN, DERATING_TARGET: 0.5 };

  /**
   * What to actually fit, from Vishay's MnO2 derating table (below 85 °C).
   *
   * This assumes a manganese-dioxide part, which is what an AVX TAP or any
   * ordinary through-hole replacement is. It matters: a conductive-polymer
   * tantalum fails benignly rather than igniting, and its published guidance is
   * far more generous -- 90% of rated up to 10 V, 80% above. Fitting a polymer
   * part and then applying the polymer rule would leave far less headroom than
   * these numbers, so the two must not be mixed up.
   *
   * The table is not a flat 50%: it tightens as the rail rises, reaching about
   * 43% by 15 V, and the paper says plainly that ratings of 35 V and above want
   * more derating still.
   */
  var VISHAY_MNO2 = [
    { rail: 3.3, rated: 6.3 },
    { rail: 5,   rated: 10 },
    { rail: 10,  rated: 20 },
    { rail: 12,  rated: 25 },
    { rail: 15,  rated: 35 },
    { rail: 24,  rated: 50 },
    { rail: 28,  rated: 63 },
    { rail: 32,  rated: 75 }
  ];

  // What you can actually buy in a TAP-style series.
  var STANDARD_RATINGS = [4, 6.3, 10, 16, 20, 25, 35, 50, 63, 75, 100];

  /**
   * The rating to fit on a given rail, and the standard size that meets it.
   *
   * Below the table's first row a plain 50% rule is used; above its last, the
   * ratio of the last row is carried on, and `seriesSuggested` says what the
   * paper says -- that past about 24 V a series pair is the honest answer,
   * because a single part that far derated may not exist in the case size.
   */
  Caps.recommend = function (appliedV) {
    if (appliedV == null || isNaN(appliedV)) return null;
    var v = Math.abs(appliedV);
    var wanted;
    if (v <= VISHAY_MNO2[0].rail) {
      wanted = v / Caps.DERATING_TARGET;
    } else {
      var lo = VISHAY_MNO2[0], hi = null;
      for (var i = 0; i < VISHAY_MNO2.length; i++) {
        if (VISHAY_MNO2[i].rail <= v) lo = VISHAY_MNO2[i];
        else { hi = VISHAY_MNO2[i]; break; }
      }
      // Interpolate on the ratio the table implies, rather than on the rating,
      // so a rail between two rows is not rounded down into less margin.
      var ratio = hi
        ? (lo.rail / lo.rated) + ((v - lo.rail) / (hi.rail - lo.rail)) *
            ((hi.rail / hi.rated) - (lo.rail / lo.rated))
        : (lo.rail / lo.rated);
      wanted = v / ratio;
    }
    var fit = null;
    for (var j = 0; j < STANDARD_RATINGS.length; j++) {
      if (STANDARD_RATINGS[j] >= wanted - 1e-9) { fit = STANDARD_RATINGS[j]; break; }
    }
    return {
      minimumV: Math.round(wanted * 10) / 10,
      standardV: fit,
      seriesSuggested: v >= 24,
      basis: 'Vishay MnO2 table, below 85 °C'
    };
  };

  /* ---- ESR ------------------------------------------------------------- */

  /**
   * The most ESR a healthy part should have.
   *
   * Neither a tantalum nor an aluminium datasheet states ESR directly for these
   * sizes -- both state a dissipation factor, and ESR falls out of it:
   *
   *     ESR = DF / (2 * pi * f * C)      with f = 120 Hz, the standard
   *
   * so the limit is a function of capacitance, and a big can is allowed far
   * less ESR than a small one. That is why "4 ohms" means nothing until you
   * know whether the part is 1 uF or 100 uF.
   *
   * The tantalum bands are AVX's own, from the TAP datasheet -- the series the
   * replacements will come from. The aluminium bands are a general-purpose
   * radial rule rather than one part's datasheet, because the originals here
   * are thirty-year-old parts from several makers and no single datasheet
   * covers them; they are marked as such so nobody mistakes them for a spec.
   */
  var TA_DF = [
    { upTo: 1.5e-6, df: 0.04 },
    { upTo: 6.8e-6, df: 0.06 },
    { upTo: 68e-6,  df: 0.08 },
    { upTo: Infinity, df: 0.10 }
  ];

  /**
   * Aluminium tan δ, from a general-purpose radial datasheet (Nichicon VX),
   * measured at 120 Hz and 20 °C.
   *
   * This is a gross upper limit, not a precise figure, and it does not need to
   * be precise: the parts on these boards are thirty years old, from makers
   * whose datasheets are long gone, and the question being asked is "is this
   * one obviously finished" rather than "does it still meet its original spec".
   *
   * The table is not monotonic, and that is the whole point. tan δ falls as the
   * rating rises to 63-100 V, then jumps back up for high-voltage parts, which
   * use much thicker foil and a different electrolyte. So a 1 uF 400 V part is
   * allowed about 330 ohms brand new, while a 1000 uF 16 V part is allowed a
   * fifth of an ohm -- the same 20 ohm reading is healthy on the first and
   * means the second is long dead. No single "low ESR is good" threshold can
   * say that; only a bound that depends on capacitance and rating together can.
   *
   * The numbers are the loosest of the common series, on purpose. tan δ varies
   * enormously between series for the same value and rating -- a physically
   * large general-purpose part (Nichicon VX) is specified at 0.10 for 50 V,
   * while a miniature one (Rubycon YXM) is allowed 0.19 for the same 22 uF
   * 50 V, because a smaller can has less foil and shorter windings. Using the
   * tighter figure would fail a brand-new miniature part, which is the one
   * mistake this must not make: a bound that condemns good parts is worse than
   * no bound at all. So the table takes the permissive end, and a reading past
   * it is dead under any series anyone would have fitted.
   *
   * A modern low-ESR replacement will sit far under these numbers. That is
   * expected and is not a fault: the bound catches parts that have dried out,
   * and being well inside it is what a healthy part of any series looks like.
   */
  var AL_DF = [
    { minV: 350, df: 0.25 },
    { minV: 160, df: 0.20 },
    { minV: 100, df: 0.15 },
    { minV: 63,  df: 0.17 },
    { minV: 50,  df: 0.19 },
    { minV: 35,  df: 0.22 },
    { minV: 25,  df: 0.30 },
    { minV: 16,  df: 0.35 },
    { minV: 10,  df: 0.45 },
    { minV: 0,   df: 0.50 }
  ];

  // The datasheets add 0.02 to tan δ for every 1000 uF past the first, because
  // a bigger winding has more foil resistance in it. Completed thousands, not
  // started ones: 2200 uF is one step over the first thousand, not two, and
  // counting the started thousand would let a drying can read "pass" against a
  // limit 6–9% looser than the rule being cited.
  function alDfAdder(farads) {
    var uF = farads * 1e6;
    return uF > 1000 ? 0.02 * Math.floor((uF - 1000) / 1000) : 0;
  }

  var DF_FREQ = 120;

  /**
   * {maxESR, df, basis, exact} or null when the value is not known.
   *
   * `exact` is false for aluminium, where the DF is a class rule rather than
   * this part's published figure -- worth showing differently, because a
   * verdict is only as good as the limit it was judged against.
   */
  Caps.esrLimit = function (item, dataset) {
    if (!item || item.kind !== 'cap' || !global.Parts) return null;
    var spec = global.Parts.spec(item);
    if (!spec || spec.quantity !== 'capacitance' || !spec.base) return null;
    var type = capType(item);
    var df = null, basis = null, exact = false;
    if (type === 'TA') {
      for (var i = 0; i < TA_DF.length; i++) {
        if (spec.base <= TA_DF[i].upTo) { df = TA_DF[i].df; break; }
      }
      basis = 'AVX TAP dissipation factor at 120 Hz';
      exact = true;
    } else if (type === 'AL') {
      var rated = global.Parts.ratedVoltage(item);
      for (var j = 0; j < AL_DF.length; j++) {
        if (rated == null || rated >= AL_DF[j].minV) { df = AL_DF[j].df; break; }
      }
      df += alDfAdder(spec.base);
      basis = 'gross upper limit from a general-purpose aluminium tan δ table ' +
              '(Nichicon VX, 120 Hz) — a screening bound, not this part’s own ' +
              'datasheet. A low-ESR series reads far below it when new, so passing ' +
              'this is not proof of health; failing it is proof of the opposite';
    } else {
      return null;
    }
    return {
      df: df,
      maxESR: df / (2 * Math.PI * DF_FREQ * spec.base),
      basis: basis,
      exact: exact
    };
  };

  /**
   * Judge a measured ESR — but only where ESR is a diagnosis.
   *
   * This differs by family, and the difference is the whole point:
   *
   * An **aluminium** capacitor fails by losing its electrolyte to evaporation.
   * As it dries the plate area still wets shrinks, so ESR climbs long before
   * the capacitance has gone anywhere interesting. Rising ESR *is* the failure,
   * and judging it against what the part was allowed when new is a real
   * verdict. The limit depends on capacitance and on the voltage rating
   * together, which is why "4 ohms" says nothing until you know both.
   *
   * A **tantalum** has a solid electrolyte and nothing to evaporate. Its ESR is
   * effectively constant over its life, so a reading is not a health check and
   * calling it pass or fail would invent a diagnosis the part cannot have.
   * Tantalums fail by voltage stress, which is what the derating audit is for.
   * The reading is still worth taking: it is the number to compare the
   * replacement against the original, so a wrong or counterfeit part shows up
   * before it goes in. So this returns `reference` rather than a verdict.
   */
  Caps.judgeESR = function (item, measuredOhms, dataset) {
    var lim = Caps.esrLimit(item, dataset);
    if (!lim || measuredOhms == null || isNaN(measuredOhms)) return null;
    var ratio = measuredOhms / lim.maxESR;
    var type = capType(item);
    var out = {
      maxESR: lim.maxESR, df: lim.df, basis: lim.basis, exact: lim.exact,
      measured: measuredOhms, ratio: ratio, type: type
    };
    if (type !== 'AL') {
      // Recorded for comparison, not scored. A tantalum well above the
      // datasheet figure is a wrong part rather than a worn one.
      out.verdict = 'reference';
      out.diagnostic = false;
      out.label = ratio > 2
        ? 'Well above the datasheet figure — check it is the right part'
        : 'Recorded for comparison — tantalum ESR does not drift with age';
      return out;
    }
    out.diagnostic = true;
    // Twice the limit is not a rule of thumb: the datasheets define end of life
    // as "tan δ 200% or less than the initial specified value" after their
    // endurance test, so a part past double has failed by the maker's own
    // criterion.
    out.verdict = ratio > 2 ? 'fail' : (ratio > 1 ? 'marginal' : 'pass');
    out.label = out.verdict === 'fail' ? 'ESR past twice the limit — dried out'
              : out.verdict === 'marginal' ? 'ESR over the limit — drying out'
              : 'ESR within limit';
    return out;
  };

  /**
   * The replacement against the part it replaced.
   *
   * For a tantalum this is the useful comparison, since neither figure moves
   * with age: a new part far off the old one is the wrong part, not a better
   * one.
   */
  Caps.compareESR = function (originalOhms, replacementOhms) {
    if (originalOhms == null || replacementOhms == null ||
        isNaN(originalOhms) || isNaN(replacementOhms) || !originalOhms) return null;
    var ratio = replacementOhms / originalOhms;
    return {
      ratio: ratio,
      close: ratio >= 0.4 && ratio <= 2.5,
      label: ratio >= 0.4 && ratio <= 2.5
        ? 'in the same range as the original'
        : (ratio < 0.4 ? 'much lower than the original — a different construction'
                       : 'much higher than the original — check the part')
    };
  };

  /* ---- author overrides ------------------------------------------------ */

  var overrides = load();

  function load() {
    try {
      return JSON.parse(global.localStorage.getItem(KEY)) || {};
    } catch (err) {
      return {};
    }
  }

  function persist() {
    try {
      global.localStorage.setItem(KEY, JSON.stringify(overrides));
    } catch (err) { /* session-only is acceptable */ }
  }

  function keyFor(assembly, ref) { return assembly + '/' + ref; }

  /** What a person corrected by hand, or null. */
  Caps.override = function (assembly, ref) {
    return overrides[keyFor(assembly, ref)] || null;
  };

  /**
   * Correct a rating or an applied voltage.
   *
   * Passing null for a field clears that field back to what the dataset says,
   * which is not the same as setting it to zero -- a cleared applied voltage
   * means "unknown again", and zero would mean "this node sits at ground".
   */
  Caps.setOverride = function (assembly, ref, patch) {
    var k = keyFor(assembly, ref);
    var cur = overrides[k] || {};
    Object.keys(patch).forEach(function (f) {
      if (patch[f] == null) delete cur[f];
      else cur[f] = patch[f];
    });
    if (Object.keys(cur).length) overrides[k] = cur;
    else delete overrides[k];
    persist();
    if (global.BoardExplorer) global.BoardExplorer.emit('capaudit', { assembly: assembly, ref: ref });
    return Caps.override(assembly, ref);
  };

  Caps.clearOverride = function (assembly, ref) {
    delete overrides[keyFor(assembly, ref)];
    persist();
    if (global.BoardExplorer) global.BoardExplorer.emit('capaudit', { assembly: assembly, ref: ref });
  };

  Caps.overrideCount = function (assembly) {
    return Object.keys(overrides).filter(function (k) {
      return !assembly || k.indexOf(assembly + '/') === 0;
    }).length;
  };

  /** For the service log export, so a correction travels with the record. */
  Caps.dump = function () { return JSON.parse(JSON.stringify(overrides)); };

  Caps.ingest = function (blob) {
    if (!blob) return 0;
    var n = 0;
    Object.keys(blob).forEach(function (k) {
      if (!overrides[k]) { overrides[k] = blob[k]; n++; }
    });
    if (n) persist();
    return n;
  };

  /* ---- the audit ------------------------------------------------------- */

  function bandFor(ratio) {
    if (ratio == null || isNaN(ratio)) return UNKNOWN;
    for (var i = 0; i < BANDS.length; i++) {
      if (ratio >= BANDS[i].from) return BANDS[i];
    }
    return BANDS[BANDS.length - 1];
  }

  /**
   * Everything known about one capacitor's voltage margin.
   *
   * Returns null for anything that is not a capacitor. `appliedV` may be null,
   * which is an honest answer and gives the 'unknown' band rather than a
   * flattering one -- an untraced rail is not evidence of safety.
   */
  Caps.audit = function (item, dataset) {
    if (!item || item.kind !== 'cap') return null;
    var d = dataset || (global.BoardExplorer && global.BoardExplorer.state.assembly);
    if (!d) return null;

    var curated = (d.capAudit || {})[item.ref] || {};
    var edit = Caps.override(d.id, item.ref) || {};

    var ratedV = edit.ratedV != null ? edit.ratedV
               : (curated.ratedV != null ? curated.ratedV
                  : (global.Parts ? global.Parts.ratedVoltage(item) : null));
    var appliedV = edit.appliedV != null ? edit.appliedV
                 : (curated.appliedV != null ? curated.appliedV : null);

    var ratio = (ratedV && appliedV != null) ? Math.abs(appliedV) / ratedV : null;
    var band = bandFor(ratio);
    var type = capType(item);

    return {
      ref: item.ref,
      assembly: d.id,
      type: type,
      isTantalum: type === 'TA',
      ratedV: ratedV,
      appliedV: appliedV,
      net: edit.net != null ? edit.net : (curated.net || null),
      ratio: ratio,
      // Headroom in volts. Negative means it is over its rating.
      marginV: (ratedV != null && appliedV != null) ? ratedV - Math.abs(appliedV) : null,
      // What to fit instead, per the MnO2 derating table. The table is a
      // solid-tantalum failure model, so only a tantalum row carries it: an
      // aluminium or film part is replaced at the rating it came with, and
      // tantalum derating guidance on those rows would contradict that.
      recommend: type === 'TA' ? Caps.recommend(appliedV) : null,
      risk: band.id,
      riskLabel: band.label,
      riskHint: band.hint,
      rank: RANK[band.id],
      railClass: edit.railClass || curated.railClass || null,
      source: edit.ratedV != null || edit.appliedV != null ? 'edited'
              : (curated.source || null),
      note: curated.note || null,
      edited: !!(edit.ratedV != null || edit.appliedV != null)
    };
  };

  /**
   * TA, AL, CER ... straight off the description's second field.
   *
   * Anchored on the word boundary rather than the start of the string, because
   * not every parts list starts the line with CAP. A20's rows are surface-mount
   * and read "CAPACITOR SMR,CAP,TA,220UF,+-20%,10V,7343H" -- a leading category
   * word, then the same description everything else uses. Anchoring at the
   * start classified all 51 of A20's capacitors as null, which is not a
   * cosmetic loss: an unclassified part is not a tantalum as far as the audit
   * is concerned, so A20's four tantalums never appeared in the recap round at
   * all -- including C1, which sits at 52% of its rating. A board that silently
   * contributes nothing looks exactly like a board with nothing to contribute.
   */
  function capType(item) {
    var m = /\bCAP,\s*([A-Z]+)/i.exec(item.desc || '');
    return m ? m[1].toUpperCase() : null;
  }
  Caps.type = capType;

  var TYPE_LABELS = {
    TA: 'Tantalum', AL: 'Aluminium', CER: 'Ceramic', MICA: 'Mica',
    POLYES: 'Polyester', POLYPR: 'Polypropylene', POLYCA: 'Polycarbonate'
  };
  Caps.typeLabel = function (t) { return TYPE_LABELS[t] || t || 'Capacitor'; };

  /**
   * Every capacitor on a board, audited, worst first.
   *
   * Worst means the band, then how far into it -- so an over-rating part leads,
   * and within a band the tightest margin comes first. An untraced part sorts
   * above merely marginal ones on purpose: it is the one whose answer is
   * missing, and missing is what gets someone hurt.
   */
  Caps.list = function (dataset, opts) {
    var d = dataset || (global.BoardExplorer && global.BoardExplorer.state.assembly);
    if (!d) return [];
    var options = opts || {};
    var out = [];
    (d.components || []).forEach(function (c) {
      if (c.kind !== 'cap') return;
      var a = Caps.audit(c, d);
      if (!a) return;
      if (options.types && options.types.indexOf(a.type) < 0) return;
      if (options.risk && a.risk !== options.risk) return;
      a.item = c;
      out.push(a);
    });
    out.sort(byRisk);
    return out;
  };

  /**
   * Every capacitor in the instrument, from every registered board.
   *
   * Ordering a recap one board at a time is how you end up with eleven part
   * numbers that were really three, so the audit has to be able to answer
   * across the whole instrument as well as across one board. The ranking is
   * the same: the worst margin anywhere leads, and the board it happens to be
   * on is a detail carried on the row rather than a grouping.
   */
  Caps.listAll = function (opts) {
    var BE = global.BoardExplorer;
    if (!BE) return [];
    var out = [];
    BE.list().forEach(function (d) {
      out = out.concat(Caps.list(d, opts));
    });
    out.sort(byRisk);
    return out;
  };

  function byRisk(x, y) {
    if (x.rank !== y.rank) return x.rank - y.rank;
    var xr = x.ratio == null ? -1 : x.ratio;
    var yr = y.ratio == null ? -1 : y.ratio;
    if (xr !== yr) return yr - xr;
    if (x.assembly !== y.assembly) return sortAsm(x.assembly, y.assembly);
    return sortRef(x.ref, y.ref);
  }

  function sortRef(a, b) {
    var ma = /^([A-Z]+)(\d+)/.exec(a), mb = /^([A-Z]+)(\d+)/.exec(b);
    if (ma && mb && ma[1] === mb[1]) return +ma[2] - +mb[2];
    return a < b ? -1 : 1;
  }

  // A10 comes after A9, not after A1 -- the instrument numbers its boards.
  function sortAsm(a, b) {
    var na = parseInt(String(a).replace(/^[A-Za-z]+/, ''), 10);
    var nb = parseInt(String(b).replace(/^[A-Za-z]+/, ''), 10);
    if (na !== nb) return na - nb;
    return a < b ? -1 : a > b ? 1 : 0;
  }
  Caps.sortAsm = sortAsm;

  /**
   * How many of each band, for the summary row.
   *
   * `dataset` may be a dataset, or null for the board that is on screen, or the
   * string 'all' for the whole instrument.
   */
  Caps.summary = function (dataset, opts) {
    var counts = { error: 0, critical: 0, high: 0, unknown: 0, marginal: 0, ok: 0 };
    var rows = dataset === 'all' ? Caps.listAll(opts) : Caps.list(dataset, opts);
    rows.forEach(function (a) { counts[a.risk]++; });
    return counts;
  };

  global.Caps = Caps;
})(window);
