/*
 * search.js — one search box over designators, signals, descriptions, stock
 * numbers, manufacturer part numbers, schematic zones and user notes.
 *
 * Ranking matters more than cleverness here: typing "C13" must put C13 first
 * and C130-ish neighbours after it, and typing "3300UF" must find the four
 * filter caps by value. Everything is a substring match with a scored ordering
 * rather than a fuzzy matcher, because designators are short and a fuzzy match
 * on short strings mostly produces noise.
 */
(function (global) {
  'use strict';

  var BE = global.BoardExplorer;
  var Notes = global.Notes;

  var Search = {};

  function fields(item) {
    var out = [];
    if (item.ref) out.push(item.ref);
    if (item.signal) out.push(item.signal);
    if (item.desc) out.push(item.desc);
    if (item.fluke) out.push(item.fluke);
    if (item.mfrPart) out.push(item.mfrPart);
    if (item.mfrCode) out.push(item.mfrCode);
    if (item.note) out.push(item.note);
    if (item.asBuilt) {
      if (item.asBuilt.desc) out.push(item.asBuilt.desc);
      if (item.asBuilt.fluke) out.push(item.asBuilt.fluke);
      if (item.asBuilt.mfrPart) out.push(item.asBuilt.mfrPart);
    }
    (item.sch || []).forEach(function (s) {
      if (s.zone) out.push(s.sheet + '/' + s.zone);
      if (s.zone) out.push(s.zone);
    });
    return out;
  }

  /**
   * @param {string} query
   * @param {object} opts  {testPointsOnly: bool, limit: number}
   * @returns {Array} [{item, score, why}]
   */
  Search.run = function (query, opts) {
    var options = opts || {};
    var dataset = BE.state.assembly;
    if (!dataset) return [];
    var q = (query || '').trim().toUpperCase();
    var pool = options.testPointsOnly
      ? (dataset.testpoints || [])
      : BE.items(dataset);

    if (!q) {
      return pool.slice(0, options.limit || 400).map(function (item) {
        return { item: item, score: 0, why: null };
      });
    }

    var noteHits = {};
    if (Notes && q.length >= 3) {
      Notes.search(dataset.id, query.trim()).forEach(function (r) { noteHits[r] = true; });
    }

    var results = [];
    pool.forEach(function (item) {
      var ref = (item.ref || '').toUpperCase();
      var score = -1, why = null;

      if (ref === q) { score = 100; why = 'designator'; }
      else if (ref.indexOf(q) === 0) { score = 90 - Math.min(9, ref.length - q.length); why = 'designator'; }
      else {
        var sig = (item.signal || '').toUpperCase();
        if (sig === q) { score = 88; why = 'signal'; }
        else if (sig.indexOf(q) >= 0) { score = 74; why = 'signal'; }
        else {
          var hit = fields(item).find(function (f) {
            return String(f).toUpperCase().indexOf(q) >= 0;
          });
          if (hit) {
            // A curated note talks about other parts as much as its own — a
            // wire loop whose note mentions "filter cap" is not what someone
            // typing CAP is after — so a note hit ranks below any part whose
            // own description matches, and is labelled as a note rather than
            // left looking like an arbitrary match.
            if (hit === item.note) { score = 45; why = 'note'; }
            else {
              score = /^\d{6}$/.test(q) ? 70 : 50;
              why = hit === item.desc ? 'description'
                : (hit === item.fluke ? 'stock no' : 'match');
            }
          }
        }
      }
      if (score < 0 && noteHits[item.ref]) { score = 40; why = 'note'; }
      if (score < 0) return;

      // Test points sort above ordinary parts on equal footing: someone typing
      // a rail name is almost always looking for where to put the probe.
      if (item.isTestPoint) score += 4;
      results.push({ item: item, score: score, why: why });
    });

    results.sort(function (a, b) {
      if (b.score !== a.score) return b.score - a.score;
      return naturalCompare(a.item.ref, b.item.ref);
    });
    return results.slice(0, options.limit || 400);
  };

  /** 'C9' before 'C13'. */
  function naturalCompare(a, b) {
    var ma = /^([A-Z]+)(\d+)$/.exec(a || ''), mb = /^([A-Z]+)(\d+)$/.exec(b || '');
    if (ma && mb) {
      if (ma[1] !== mb[1]) return ma[1] < mb[1] ? -1 : 1;
      return parseInt(ma[2], 10) - parseInt(mb[2], 10);
    }
    return (a || '') < (b || '') ? -1 : 1;
  }
  Search.naturalCompare = naturalCompare;

  global.Search = Search;
})(window);
