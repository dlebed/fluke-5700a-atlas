/*
 * parts.js — what a component is supposed to be, and what you measured on it.
 *
 * Two jobs, both in service of the same sentence: "R211 reads 4.71 k, the BOM
 * says 4.7 k +/-1%".
 *
 * The first is the quantities a part can be measured in. A test point has one
 * number and one unit; a component has several, and which ones make sense
 * depends on what it is -- capacitance and ESR on an electrolytic, forward
 * voltage on a diode, nothing meaningful on a bracket.
 *
 * The second is reading the value back out of the parts list. Fluke writes
 * descriptions as comma-separated fields, "CAP,AL,470UF,+-20%,16V,SOLV PROOF",
 * and the value is in there in a regular enough form to find. Not always,
 * though: "RES,CERM,SIP,8 PIN,7 RES,10K,+-2%" is seven resistors and the 10K is
 * each, not the part, and "DIODE,SI,HIGH VOLTAGE,PIV=2K,4OMA" has an OCR'd
 * letter O in what should be 40MA. So this declines whenever it is not sure,
 * and a declined parse costs a blank field while a wrong one silently accuses
 * a good part of being out of spec.
 */
(function (global) {
  'use strict';

  var Parts = {};

  /* ---- quantities ---- */

  // Multipliers, keyed by the exact string shown to the user. Ohm is spelled
  // with the ohm sign U+03A9 throughout; anything else invites two spellings of
  // the same unit in one export.
  var SCALE = {
    'V': 1, 'mV': 1e-3, 'µV': 1e-6, 'kV': 1e3,
    'A': 1, 'mA': 1e-3, 'µA': 1e-6, 'nA': 1e-9,
    'Ω': 1, 'mΩ': 1e-3, 'kΩ': 1e3, 'MΩ': 1e6,
    'F': 1, 'mF': 1e-3, 'µF': 1e-6, 'nF': 1e-9, 'pF': 1e-12,
    'H': 1, 'mH': 1e-3, 'µH': 1e-6,
    'Hz': 1, 'kHz': 1e3, 'MHz': 1e6,
    '': 1
  };

  var QUANTITIES = [
    { id: 'voltage',     label: 'Voltage',      base: 'V',  units: ['V', 'mV', 'kV'] },
    { id: 'resistance',  label: 'Resistance',   base: 'Ω',  units: ['Ω', 'mΩ', 'kΩ', 'MΩ'] },
    // No mF: it is a real prefix that nothing on these boards is ever labelled
    // in, and offering it means 3300 µF reads back as "3.3 mF".
    { id: 'capacitance', label: 'Capacitance',  base: 'F',  units: ['µF', 'nF', 'pF'] },
    { id: 'esr',         label: 'ESR',          base: 'Ω',  units: ['Ω', 'mΩ'] },
    { id: 'inductance',  label: 'Inductance',   base: 'H',  units: ['mH', 'µH', 'H'] },
    { id: 'vf',          label: 'Forward drop', base: 'V',  units: ['V', 'mV'] },
    { id: 'leakage',     label: 'Leakage',      base: 'A',  units: ['µA', 'nA', 'mA'] },
    { id: 'current',     label: 'Current',      base: 'A',  units: ['A', 'mA'] },
    { id: 'frequency',   label: 'Frequency',    base: 'Hz', units: ['Hz', 'kHz', 'MHz'] },
    { id: 'hfe',         label: 'Gain (hFE)',   base: '',   units: [''] }
  ];

  // What to offer first for each kind of part. The list is not a restriction --
  // every quantity stays available -- it is only about not making someone scroll
  // past capacitance to measure a resistor.
  var BY_KIND = {
    res: ['resistance'], resnet: ['resistance'], thermistor: ['resistance'],
    cap: ['capacitance', 'esr', 'leakage'],
    diode: ['vf', 'resistance'], zener: ['voltage', 'vf'],
    transistor: ['hfe', 'vf'], fuse: ['resistance'],
    jumper: ['resistance'], relay: ['resistance', 'voltage'],
    inductor: ['inductance', 'resistance'], transformer: ['resistance'],
    crystal: ['frequency'], ic: ['voltage'], connector: ['resistance'],
    switch: ['resistance'], socket: ['resistance'], wire: ['resistance']
  };

  Parts.quantities = function () { return QUANTITIES.slice(); };

  Parts.quantity = function (id) {
    return QUANTITIES.find(function (q) { return q.id === id; }) || null;
  };

  /** Quantities worth offering for this item, most likely first. */
  Parts.quantitiesFor = function (item) {
    if (!item) return QUANTITIES.slice();
    if (item.isTestPoint) return [Parts.quantity('voltage')];
    var preferred = BY_KIND[item.kind] || [];
    var head = preferred.map(Parts.quantity).filter(Boolean);
    var rest = QUANTITIES.filter(function (q) { return preferred.indexOf(q.id) < 0; });
    return head.concat(rest);
  };

  Parts.units = function (quantityId) {
    var q = Parts.quantity(quantityId);
    return q ? q.units.slice() : [''];
  };

  /**
   * How many pins the part has, and how confident that is.
   *
   * Only 39 of this instrument's 220 ICs state a pin count in their
   * description, so a guess is wrong far more often than it is right and must
   * say so. The three answers are worth different amounts:
   *
   *   'stated'  the description says it -- "14 PIN DIP", "DIP16". Trust it.
   *   'package' a transistor. Every TO- package in these parts lists is a
   *             three-lead device, and a three-lead part is the overwhelming
   *             default even where the package is not named.
   *   'guess'   nothing said so. 8 is the most common stated count in this
   *             instrument (24 parts against 14-pin's 9), so it is the least
   *             bad opening bid -- but the caller must let it be changed, and
   *             must not present it as knowledge.
   *
   * Returns null for kinds where pin numbering means nothing.
   */
  Parts.pinCount = function (item) {
    if (!item || item.isTestPoint) return null;
    if (item.kind !== 'ic' && item.kind !== 'transistor') return null;
    var desc = item.desc || '';

    var m = /(\d+)\s*-?\s*PINS?\b/i.exec(desc) || /\bDIP\s*-?\s*(\d+)/i.exec(desc);
    if (m) {
      var n = parseInt(m[1], 10);
      if (n >= 2 && n <= 64) return { n: n, source: 'stated' };
    }
    if (item.kind === 'transistor') return { n: 3, source: 'package' };
    return { n: 8, source: 'guess' };
  };

  /** A measurement in its base unit, for comparing against anything else. */
  Parts.toBase = function (value, unit) {
    if (value == null || isNaN(value)) return null;
    var scale = SCALE[unit];
    return scale == null ? null : value * scale;
  };

  /**
   * A base-unit number rendered with a sensible prefix, e.g. 4700 -> "4.7 kΩ".
   *
   * `preferUnit` pins it to a particular one, which is what puts a measurement
   * and the parts list's own figure in the same unit so they can be read
   * against each other. "0.71 µF against 0.72 µF" is a comparison; "710 nF
   * against 0.72UF" is arithmetic homework.
   */
  Parts.format = function (base, quantityId, preferUnit) {
    if (base == null || isNaN(base)) return '—';
    var q = Parts.quantity(quantityId);
    if (!q) return String(base);
    if (preferUnit != null && SCALE[preferUnit] != null) {
      return trim(base / SCALE[preferUnit]) + (preferUnit ? ' ' + preferUnit : '');
    }
    if (!q.base) return trim(base);
    var choices = q.units.slice().sort(function (a, b) { return SCALE[b] - SCALE[a]; });
    for (var i = 0; i < choices.length; i++) {
      var scaled = base / SCALE[choices[i]];
      if (Math.abs(scaled) >= 1) return trim(scaled) + ' ' + choices[i];
    }
    var last = choices[choices.length - 1];
    return trim(base / SCALE[last]) + ' ' + last;
  };

  function trim(v) {
    var r = Math.abs(v) >= 100 ? v.toFixed(1)
          : Math.abs(v) >= 10 ? v.toFixed(2)
          : v.toFixed(3);
    return r.replace(/\.?0+$/, '');
  }

  /* ---- reading the value out of the parts list ---- */

  // Which quantity a designator's own description would be stating, if it
  // states one at all. Anything not here is not parsed: an IC has no single
  // value, a bracket has none, and a diode's description gives a peak inverse
  // voltage, which is not something a meter reads.
  var SPEC_QUANTITY = {
    res: 'resistance', thermistor: 'resistance',
    cap: 'capacitance', zener: 'voltage', fuse: 'current'
  };

  // \d*\.?\d+ rather than \d+(\.\d+)? because the parts list writes tenths as
  // ".1" as often as "0.1" -- "RES,WW,.1,+-3%,.7W" is a real row.
  var NUM = '(\\d*\\.?\\d+)';
  var VALUE = {
    resistance: new RegExp('^' + NUM + '\\s*(K|M|R)?$', 'i'),
    capacitance: new RegExp('^' + NUM + '\\s*(P|N|U|M)F$', 'i'),
    voltage: new RegExp('^' + NUM + '\\s*(K|M)?V$', 'i'),
    current: new RegExp('^' + NUM + '\\s*(M|U)?A$', 'i')
  };
  var TOLERANCE = new RegExp('^' + NUM + '\\s*%$');
  // "+80-20%", "+30-20%" -- an aluminium or Z5U part, generous upward and
  // tight downward. The signs are part of the shape, so NUM is not reused.
  var ASYM_TOLERANCE = /^\+(\d*\.?\d+)\s*-\s*(\d*\.?\d+)\s*%$/;

  var MULT = {
    resistance: { '': 1, R: 1, K: 1e3, M: 1e6 },
    capacitance: { P: 1e-12, N: 1e-9, U: 1e-6, M: 1e-3 },
    voltage: { '': 1, K: 1e3, M: 1e6 },
    current: { '': 1, M: 1e-3, U: 1e-6 }
  };

  // The unit the parts list wrote the value in, so a measurement can be shown
  // beside it in the same one.
  var SPEC_UNIT = {
    resistance: { '': 'Ω', R: 'Ω', K: 'kΩ', M: 'MΩ' },
    capacitance: { P: 'pF', N: 'nF', U: 'µF', M: 'mF' },
    voltage: { '': 'V', K: 'kV', M: 'MV' },
    current: { '': 'A', M: 'mA', U: 'µA' }
  };

  /**
   * What the parts list says this component should be.
   *
   * Returns {quantity, base, tolerancePct, text} or null. Null is the normal
   * answer for most of the BOM and is not a failure: it means the description
   * does not state a measurable value, or does not state one this can read
   * without guessing.
   */
  Parts.spec = function (item) {
    if (!item || item.isTestPoint) return null;
    var quantity = SPEC_QUANTITY[item.kind];
    if (!quantity || !item.desc) return null;
    // A network states the value of each element, not of the part, and there is
    // no way to measure "the" resistance of it. Say nothing rather than
    // something misleading.
    if (/\bR-?NET|RNET|\d+\s*RES\b|SIP\b/i.test(item.desc)) return null;

    // Split on "+-" as well as on commas. The separator between a value and
    // its tolerance is sometimes missing -- "RES,CF,51K+-5%,0.25W" -- and "+-"
    // can only ever begin a tolerance, so cutting there recovers the value
    // without having to interpret anything. A trailing full stop goes the same
    // way: "3.9K." is punctuation, not a number.
    // "CAP,AL,6800UF,+-20%.25V" is missing the comma before its voltage
    // rating. A per cent sign ends a tolerance and nothing else, so a digit
    // following one across a full stop began a new field.
    var desc = item.desc.replace(/%\s*\.(?=\d)/g, '%,');

    // Everything after a "+-" rates the value rather than being one, and that
    // has to be remembered rather than inferred later: "+-0.1PF" reads exactly
    // like a capacitance, and on "CAP,CER,6.8PF,+-0.1PF" only the position of
    // the "+-" says which of the two is the part.
    var fields = [], rating = [];
    desc.split(',').forEach(function (field) {
      field.split(/\+-/).forEach(function (part, idx) {
        part = part.trim().replace(/\.$/, '');
        if (!part) return;
        // A precision resistance set spells its unit out and runs the whole
        // specification into one comma-free field: A9's R41 and R42 are
        // "RES. SET,1.0 OHM 0.04% 3PPM TC". Every other row in the manual
        // separates value, tolerance and rating with commas, so reading a
        // field at a time never had to look inside one -- and these two are
        // the most accuracy-critical resistors on that board, so declining is
        // the wrong answer here. Unlike a network, the stated value is the
        // part's own. Split this shape on its spaces and the value and the
        // tolerance become ordinary fields; the tail (3PPM, TC) matches
        // nothing and falls through, as does the spelled-out unit.
        if (/\d\s*OHMS?\b/i.test(part) && /\s/.test(part)) {
          part.split(/\s+/).forEach(function (token) {
            if (/^OHMS?$/i.test(token)) return;
            fields.push(token);
            rating.push(idx > 0);
          });
          return;
        }
        fields.push(part);
        rating.push(idx > 0);
      });
    });
    var re = VALUE[quantity];
    var base = null, text = null, unit = null;
    for (var i = 0; i < fields.length; i++) {
      if (rating[i]) continue;
      var m = re.exec(fields[i]);
      if (!m) continue;
      var prefix = (m[2] || '').toUpperCase();
      var mult = MULT[quantity][prefix];
      if (mult == null) continue;
      base = parseFloat(m[1]) * mult;
      unit = SPEC_UNIT[quantity][prefix];
      text = fields[i];
      break;      // the first value field is the part's own; later ones rate it
    }
    if (base == null) return null;

    var spec = { quantity: quantity, base: base, unit: unit,
                 tolerancePct: null, text: text,
                 display: Parts.format(base, quantity, unit) };

    for (var j = 0; j < fields.length; j++) {
      var field = fields[j];

      var sym = TOLERANCE.exec(field);
      if (sym) { spec.tolerancePct = parseFloat(sym[1]); break; }

      // An electrolytic is not symmetrical: "+30-20%" and "+80-20%" allow far
      // more above nominal than below, and averaging the two would fail a
      // capacitor the manual considers good.
      var asym = ASYM_TOLERANCE.exec(field);
      if (asym) {
        spec.tolPctHi = parseFloat(asym[1]);
        spec.tolPctLo = parseFloat(asym[2]);
        break;
      }

      // A small ceramic states its tolerance in its own units -- "6.8PF
      // +-0.1PF" -- because a per cent of a few picofarads is not a number
      // anyone would work with.
      if (rating[j]) {
        var abs = re.exec(field);
        if (abs) {
          var absMult = MULT[quantity][(abs[2] || '').toUpperCase()];
          if (absMult != null) {
            spec.toleranceAbs = parseFloat(abs[1]) * absMult;
            break;
          }
        }
      }
    }
    return spec;
  };

  /**
   * Score a measurement against the parts list.
   *
   * Deliberately not the same scale as a test point. A published supply has a
   * limit the manual stands behind; a component tolerance is what it left the
   * factory at, and an electrolytic sitting at +18% of a +/-20% part passes
   * arithmetic while being visibly on its way out. So this reports how far off
   * nominal it is and only calls something a failure when it is genuinely
   * outside the printed tolerance.
   */
  Parts.compare = function (spec, base) {
    if (!spec || base == null || isNaN(base) || !spec.base) return null;
    var pct = ((base - spec.base) / Math.abs(spec.base)) * 100;
    var limits = Parts.limits(spec);
    var verdict = 'unscored';
    if (limits) {
      // Which way the reading went decides which limit applies, so a 3.3 uF
      // +30-20% part reading +25% passes while one reading -25% fails.
      var allowed = pct >= 0 ? limits.hi : limits.lo;
      // The epsilon is not slack, it is arithmetic: a part measured exactly at
      // its limit computes to 3.0000000000000004% of a 3% tolerance and would
      // otherwise be failed by the last bit of a double.
      var off = Math.abs(pct);
      verdict = off > allowed + 1e-9 ? 'fail'
              : (off > allowed * 0.6 ? 'marginal' : 'pass');
    }
    return { pctOffNominal: pct, verdict: verdict };
  };

  /**
   * How far above and below nominal the parts list allows, in per cent.
   *
   * Three ways of saying it end up here: a symmetrical per cent, a lopsided
   * one, and a tolerance stated in the part's own units. Null when the
   * description states no tolerance at all, which is the honest answer for
   * most of the BOM -- a reading is still recorded, it just is not scored.
   */
  Parts.limits = function (spec) {
    if (!spec) return null;
    if (spec.tolPctHi != null && spec.tolPctLo != null) {
      return { hi: spec.tolPctHi, lo: spec.tolPctLo };
    }
    if (spec.tolerancePct != null) {
      return { hi: spec.tolerancePct, lo: spec.tolerancePct };
    }
    if (spec.toleranceAbs != null && spec.base) {
      var pct = Math.abs(spec.toleranceAbs / spec.base) * 100;
      return { hi: pct, lo: pct };
    }
    return null;
  };

  /**
   * The voltage the parts list rates this part for.
   *
   * A capacitor's description ends in its rating -- "CAP,TA,4.7UF,+-20%,25V" --
   * and that number is the whole point of a tantalum audit: these instruments
   * are known for tantalums failing where the rating sits too close to the rail
   * they are on. Read for every capacitor kind, not just tantalum, because the
   * same question is worth asking of an aluminium can.
   *
   * The same missing-comma repair as spec() applies: A18's C2 and C3 print
   * "+-20%.25V", and their rating is the 25 V after it.
   */
  Parts.ratedVoltage = function (item) {
    if (!item || !item.desc) return null;
    var desc = item.desc.replace(/%\s*\.(?=\d)/g, '%,');
    var best = null;
    desc.split(',').forEach(function (field) {
      // A line-rated part states its rating with the waveform on it --
      // "CAP,POLYES,0.1UF,+-20%,250VAC" is A4's mains filter -- and the
      // suffix is part of the rating, not a different field, so it must not
      // make the one rating that guards the mains entry read as unrated.
      var m = /^\s*([\d.]+)\s*V(?:AC|DC)?\s*$/i.exec(field);
      if (m) {
        var v = parseFloat(m[1]);
        // A description states one rating; where a stray field also parses,
        // the higher number is the working voltage rather than a tolerance.
        if (best == null || v > best) best = v;
      }
    });
    return best;
  };

  /** The tolerance as the parts list states it, for showing next to a value. */
  Parts.toleranceText = function (spec) {
    if (!spec) return '';
    if (spec.tolPctHi != null && spec.tolPctLo != null) {
      return '+' + spec.tolPctHi + '/−' + spec.tolPctLo + '%';
    }
    if (spec.tolerancePct != null) return '±' + spec.tolerancePct + '%';
    if (spec.toleranceAbs != null) {
      return '±' + Parts.format(spec.toleranceAbs, spec.quantity, spec.unit);
    }
    return '';
  };

  global.Parts = Parts;
})(window);
