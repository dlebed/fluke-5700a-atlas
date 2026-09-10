/*
 * procedures.js — walking a manual troubleshooting section step by step.
 *
 * The manual's steps are prose ("measure the dc voltage at TP209 and verify it
 * is +565 ±10% ... if a failure is detected, check CR217, CR218 ..."). Two
 * things in that prose are actionable: the points to measure, and the parts to
 * suspect when the measurement is wrong. Both are pulled out so a step can put
 * its measurements into the log and light up its suspects on the board.
 */
(function (global) {
  'use strict';

  var BE = global.BoardExplorer;
  var KEY = 'fluke5700a.procedure.v2';
  var LEGACY = 'fluke5700a.procedure.v1';

  /**
   * The set of step numbers a citation names.
   *
   * Three things go wrong with the obvious spellings. A plain substring match
   * lets "step 1" find "step 11", which on A11's 44-step procedure attaches
   * §5-14's op amp pin checks to step 2. A trailing \b instead rejects the
   * manual's lettered sub-steps -- A13's expectations cite "step 8b", "step
   * 8c" and "step 11a", which belong to steps 8 and 11 and are the reason
   * those steps have any expectation at all. And the manual cites in the
   * plural as often as not -- "steps 4 and 5", "steps 6, 7, 8 and 9",
   * "steps 1 to 10", "steps 2–11 and 14–16" -- which no single-number
   * pattern can cross, so every point cited that way fell off its steps.
   *
   * So the citation is read once into the numbers it names. A list runs from
   * a "step" or "steps" until the first thing that is not a number joined by
   * a comma, an "and", or a range word or dash -- which is what stops it at
   * "steps 9, 10 and 14; Figure 7-7" without swallowing the figure. A
   * lettered sub-step counts under its base number, a range expands to every
   * step inside it, and membership is then numeric, which is what keeps 1
   * distinct from 11.
   */
  function stepsCited(source) {
    var out = {};
    if (!source) return out;
    var scan = /\bsteps?\b/g;
    var item = /^(\d+)[a-z]?/;
    var sep = /^(\s*,\s*(?:and\s+)?|\s+and\s+|\s*[–—-]\s*|\s+(?:to|through)\s+)(?=\d)/;
    var m, rest, lead, tok, join, prev, next, k;
    while ((m = scan.exec(source))) {
      rest = source.slice(scan.lastIndex);
      lead = /^\s+/.exec(rest);
      if (!lead) continue;
      rest = rest.slice(lead[0].length);
      tok = item.exec(rest);
      if (!tok) continue;
      prev = parseInt(tok[1], 10);
      out[prev] = true;
      rest = rest.slice(tok[0].length);
      while ((join = sep.exec(rest))) {
        rest = rest.slice(join[0].length);
        tok = item.exec(rest);
        if (!tok) break;
        next = parseInt(tok[1], 10);
        if (/[–—-]|\bto\b|\bthrough\b/.test(join[1]) &&
            next > prev && next - prev < 100) {
          for (k = prev + 1; k < next; k++) out[k] = true;
        }
        out[next] = true;
        prev = next;
        rest = rest.slice(tok[0].length);
      }
    }
    return out;
  }

  /** Does this citation name step n? */
  function citesText(source, n) {
    return stepsCited(source)[n] === true;
  }

  var progress = load();

  /**
   * Which steps are ticked, per unit.
   *
   * v1 keyed this by assembly alone, so two instruments on the same bench
   * shared one set of ticks -- walking A18 on one calibrator marked it walked
   * on the other. Everything else in this tool belongs to a unit first, and
   * this is no different: a step is done on an instrument, not in the abstract.
   *
   * The old store is migrated into whichever unit is active when it is first
   * read, which is the only answer available, and the v1 key is left in place
   * rather than deleted -- a migration that infers had better be reversible.
   */
  function load() {
    var raw = null, parsed = null;
    try {
      raw = global.localStorage.getItem(KEY);
    } catch (err) { /* storage unavailable; in-memory only */ }
    if (raw != null) {
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        // Corrupt rather than absent: keep the raw text where the next write
        // cannot destroy it, so the ticks can be recovered by hand.
        try { global.localStorage.setItem(KEY + '.bak', raw); } catch (e2) {}
      }
    }
    if (parsed) return parsed;
    var legacy = null;
    try {
      legacy = JSON.parse(global.localStorage.getItem(LEGACY));
    } catch (err) { return {}; }
    if (!legacy || !Object.keys(legacy).length) return {};
    var unit = global.Units ? global.Units.ensure().id : 'unknown';
    var moved = {};
    moved[unit] = legacy;
    return moved;
  }

  function unitId() {
    return global.Units ? global.Units.ensure().id : 'unknown';
  }

  function forUnit() {
    var u = unitId();
    return (progress[u] = progress[u] || {});
  }

  /*
   * Two tabs share this key, and a write is whole-store: a save from a stale
   * cache would wipe the ticks the other tab had made. So a write re-reads
   * the key first and folds unknown ticks in. Steps unticked in this tab are
   * remembered and kept out of the merge, because an untick cannot be told
   * from the other tab's tick by looking at the data.
   */
  var unticked = {};

  function mergeStore(fresh) {
    if (!fresh || typeof fresh !== 'object') return;
    Object.keys(fresh).forEach(function (u) {
      var asms = fresh[u];
      if (!asms || typeof asms !== 'object') return;
      var mine = progress[u] = progress[u] || {};
      Object.keys(asms).forEach(function (asm) {
        var steps = asms[asm];
        if (!steps || typeof steps !== 'object') return;
        var forAsm = mine[asm] = mine[asm] || {};
        Object.keys(steps).forEach(function (n) {
          if (steps[n] && !unticked[u + '/' + asm + '/' + n]) forAsm[n] = true;
        });
      });
    });
  }

  function persist() {
    try {
      var fresh = null;
      try { fresh = JSON.parse(global.localStorage.getItem(KEY)); } catch (err2) { fresh = null; }
      mergeStore(fresh);
      global.localStorage.setItem(KEY, JSON.stringify(progress));
    } catch (err) { /* session-only is acceptable */ }
  }

  var Procedures = {
    current: function (dataset) {
      return (dataset.procedures || [])[0] || null;
    },

    /**
     * The measurable points a step names, resolved against the dataset so the
     * step can offer a "record this" control per point.
     */
    targets: function (dataset, step) {
      var cites = [];
      var mentioned = [];
      (step.refs || []).forEach(function (ref) {
        var item = dataset.byRef[ref];
        if (!item || !item.isTestPoint || item.isReturn) return;   // a COM point
                                                                   // is where the
                                                                   // black lead
                                                                   // goes, not a
                                                                   // measurement
        if (Procedures.citesStep(item, step.n)) cites.push(item);
        else mentioned.push(item);
      });
      // Probe points cite the step they come from, which is how the two
      // component-level checks in step 2 and the U201 pin checks get attached.
      (dataset.probePoints || []).forEach(function (p) {
        if (citesText(p.source, step.n)) cites.push(p);
      });
      // A step usually names more points than it asks you to read -- step 8
      // jumpers TP205 and TP207 in order to measure TP210 and TP201. Where the
      // expectations say which points belong to this step, those are the
      // measurements; where none do, offer everything it mentions and let the
      // reader fill in what applies.
      return cites.length ? cites : mentioned;
    },

    /** Does any of this point's expectations come from this step? */
    citesStep: function (item, n) {
      if (citesText(item.source, n)) return true;
      return (item.states || []).some(function (s) {
        return citesText(s.source, n);
      });
    },

    /**
     * Which of a point's operating modes this step is asking about.
     *
     * A ±PA test point reads differently depending on how the supply is
     * jumpered, and each mode cites the step it comes from ("§5-23 step 8"),
     * so the step can pick its own mode instead of making someone match them
     * up by hand while holding a probe.
     */
    stateIndexForStep: function (item, n) {
      var states = global.TestPoints.states(item);
      for (var i = 0; i < states.length; i++) {
        if (citesText(states[i].source, n)) return i;
      }
      return 0;
    },

    /** Parts the step tells you to check when it fails. */
    suspects: function (dataset, step) {
      var targets = {};
      Procedures.targets(dataset, step).forEach(function (t) {
        targets[t.ref || t.id] = true;
      });
      return (step.refs || []).filter(function (ref) {
        return !targets[ref] && dataset.byRef[ref];
      });
    },

    isDone: function (assembly, n) {
      return !!(forUnit()[assembly] || {})[n];
    },

    setDone: function (assembly, n, done) {
      var u = unitId();
      var mine = progress[u] = progress[u] || {};
      var forAsm = mine[assembly] = mine[assembly] || {};
      if (done) {
        forAsm[n] = true;
        delete unticked[u + '/' + assembly + '/' + n];
      } else {
        delete forAsm[n];
        unticked[u + '/' + assembly + '/' + n] = true;
      }
      persist();
      BE.emit('procedure', { assembly: assembly, step: n });
    },

    reset: function (assembly) {
      var u = unitId();
      Object.keys((progress[u] || {})[assembly] || {}).forEach(function (n) {
        unticked[u + '/' + assembly + '/' + n] = true;
      });
      delete forUnit()[assembly];
      persist();
      BE.emit('procedure', { assembly: assembly });
    },

    /** For the service log: which steps are ticked, for these units. */
    dump: function (unitIds) {
      var out = {};
      Object.keys(progress).forEach(function (u) {
        if (!unitIds || unitIds.indexOf(u) >= 0) out[u] = progress[u];
      });
      return JSON.parse(JSON.stringify(out));
    },

    /**
     * Merge ticks arriving from a file. Never unticks anything: a step done
     * here and not in the file stays done, same as every other import.
     */
    ingest: function (blob, remap) {
      if (!blob) return 0;
      var n = 0;
      Object.keys(blob).forEach(function (u) {
        var id = (remap && remap[u]) || u;
        var mine = progress[id] = progress[id] || {};
        Object.keys(blob[u] || {}).forEach(function (asm) {
          var steps = mine[asm] = mine[asm] || {};
          Object.keys(blob[u][asm] || {}).forEach(function (step) {
            if (!steps[step]) { steps[step] = true; n++; }
          });
        });
      });
      if (n) persist();
      return n;
    },

    doneCount: function (assembly) {
      return Object.keys(forUnit()[assembly] || {}).length;
    }
  };

  // Hear about the other tab's writes as they happen, so this tab's tick
  // marks do not go stale between its own writes. The event fires only in
  // the tabs that did not make the write.
  if (global.addEventListener) {
    global.addEventListener('storage', function (e) {
      if (e && e.key && e.key !== KEY) return;
      var fresh = null;
      try { fresh = JSON.parse(global.localStorage.getItem(KEY)); } catch (err) { return; }
      mergeStore(fresh);
      BE.emit('procedure', {});
    });
  }

  global.Procedures = Procedures;
})(window);
