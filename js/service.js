/*
 * service.js — the whole service record of an instrument, in and out.
 *
 * Everything recorded about a calibrator lived in two places and left in two
 * files: readings in one, notes in another, joined by nothing. Half a service
 * record is not much use months later on another bench, and the half most
 * likely to go missing is the half that says why -- the notes.
 *
 * So there is one file. It carries the units it describes, every session with
 * its readings and its repairs, and every note, and it is the same file whether
 * it came from one instrument or six. Opening it merges rather than replaces:
 * having one unit's log open must never cost another's.
 *
 * Units are matched on serial number when a file is opened, not on the id
 * inside it, because the same instrument logged on two benches gets two ids and
 * one serial, and splitting its history in half is the failure this is for.
 */
(function (global) {
  'use strict';

  var FORMAT = 'fluke5700a-servicelog';
  var VERSION = 2;

  var Service = {};

  /* ---- out ---- */

  /**
   * The whole record for some units, or for all of them.
   *
   * Sessions carry their unit's serial as well as its id: an id means nothing
   * outside the file it came from, and someone reading the JSON should be able
   * to tell whose calibrator a session describes without resolving anything.
   */
  Service.exportAll = function (unitIds) {
    var units = global.Units.exportUnits(unitIds);
    var ids = units.map(function (u) { return u.id; });
    var sessions = global.TestLog.dump(unitIds ? ids : null).map(function (s) {
      var unit = global.Units.get(s.unitId);
      return Object.assign({}, s, {
        instrumentSerial: (unit && unit.serial) || s.instrumentSerial || ''
      });
    });
    return {
      format: FORMAT,
      version: VERSION,
      exportedAt: new Date().toISOString(),
      units: units,
      sessions: sessions,
      notes: global.Notes.dump(unitIds ? ids : null),
      // What was plugged into the instrument, and when it changed. A reading
      // taken with two boards pulled is not the same reading as one taken with
      // the instrument whole, so the configuration travels with the record.
      fitment: global.TestLog.dumpFitment ? global.TestLog.dumpFitment(unitIds ? ids : null) : [],
      // A corrected rail or rating is part of the record: without it the next
      // person opening this log sees the margins the dataset shipped with
      // rather than the ones that were established on the bench.
      capAudit: global.Caps ? global.Caps.dump() : {},
      // Which procedure steps have been walked. Without these the log knows
      // every reading taken and nothing about how far through the procedure
      // the last person got, which is the first thing the next one asks.
      procedure: global.Procedures ? global.Procedures.dump(unitIds ? ids : null) : {}
    };
  };

  Service.filename = function (unit, ext) {
    var serial = unit && (unit.serial || '').trim();
    // The bench clock, not the UTC one: a file exported at ten in the evening
    // must not be named for tomorrow.
    var d = new Date();
    var stamp = d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate());
    return ('5700A-' + (serial || 'unit') + '-service-' + stamp + '.' + ext)
      .replace(/[^A-Za-z0-9._-]+/g, '-');
  };

  /* ---- in ---- */

  /**
   * Open a file. Merges; never replaces.
   *
   * Accepts the single-file format, and also the two older half-records so
   * that logs written before this existed still open. Returns a summary of
   * what arrived, because "imported" on its own does not tell you whether the
   * file you picked was the one you meant.
   */
  Service.importAll = function (payload) {
    if (!payload || typeof payload !== 'object') throw new Error('not a log file');

    if (payload.format === 'fluke5700a-notes') {
      return { units: 0, sessions: 0, notes: global.Notes.ingest(payload.notes, null),
               kind: 'notes only (older format)' };
    }
    if (payload.format === 'fluke5700a-testlog') {
      return Object.assign(legacyTestLog(payload), { kind: 'readings only (older format)' });
    }
    if (payload.format !== FORMAT) {
      throw new Error('not a 5700A service log — this file says "' +
                      (payload.format || 'nothing') + '"');
    }

    // Map every unit in the file onto a local one, by serial. Everything else
    // in the file refers to units by id, so this has to happen first.
    var remap = {}, addedUnits = 0;
    (payload.units || []).forEach(function (u) {
      var result = global.Units.adoptImported(u);
      remap[result.mappedFrom] = result.unit.id;
      if (result.added) addedUnits++;
    });

    var result = {
      kind: 'service log',
      units: addedUnits,
      sessions: global.TestLog.ingest(payload.sessions, remap),
      notes: global.Notes.ingest(payload.notes, remap),
      fitment: global.TestLog.ingestFitment ? global.TestLog.ingestFitment(payload.fitment, remap) : 0,
      // Merged, never overwritten: a correction already made here outranks one
      // arriving from a file, same as every other part of an import.
      capAudit: global.Caps ? global.Caps.ingest(payload.capAudit) : 0,
      procedure: global.Procedures ? global.Procedures.ingest(payload.procedure, remap) : 0,
      serials: (payload.units || []).map(function (u) { return u.serial || '(no serial)'; })
    };
    pruneEmpty();
    return result;
  };

  /**
   * Drop the placeholder unit that gets made the first time the page opens.
   *
   * Opening a log on a fresh machine otherwise leaves an unnamed unit sitting
   * in the picker beside the real one, which is exactly the ambiguity about
   * whose instrument a record belongs to that all of this is meant to remove.
   * Only a unit with no serial and nothing recorded against it goes, and never
   * the last one standing.
   */
  function pruneEmpty() {
    global.Units.all().forEach(function (u) {
      if (global.Units.all().length < 2) return;
      if ((u.serial || '').trim()) return;
      if (global.TestLog.dump([u.id]).length) return;
      if (Object.keys(global.Notes.dump([u.id])).length) return;
      // Fitment events and procedure ticks hang off the unit too, and both
      // can be recorded with no session open. A board marked out before a
      // serial was ever typed is a record, and dropping its unit would strand
      // it against an id nothing can resolve.
      if (global.TestLog.dumpFitment && global.TestLog.dumpFitment([u.id]).length) return;
      if (global.Procedures && hasProcedureTicks(u.id)) return;
      global.Units.remove(u.id);
    });
  }

  function hasProcedureTicks(unitId) {
    var prog = global.Procedures.dump([unitId]);
    return Object.keys(prog).some(function (uid) {
      return Object.keys(prog[uid] || {}).some(function (asm) {
        return Object.keys(prog[uid][asm] || {}).length > 0;
      });
    });
  }

  /**
   * An older readings-only file has no units in it, only a serial written on
   * each session. Rebuild units from those serials so the sessions land
   * somewhere real instead of on whatever happens to be active.
   */
  function legacyTestLog(payload) {
    var remap = {}, addedUnits = 0;
    (payload.sessions || []).forEach(function (s) {
      var serial = (s.instrumentSerial || '').trim();
      var from = s.unitId || ('serial:' + serial);
      if (remap[from]) return;
      var result = global.Units.adoptImported({ id: from, serial: serial });
      remap[from] = result.unit.id;
      if (result.added) addedUnits++;
    });
    var sessions = (payload.sessions || []).map(function (s) {
      return Object.assign({}, s, { unitId: s.unitId || ('serial:' + (s.instrumentSerial || '').trim()) });
    });
    return { units: addedUnits, sessions: global.TestLog.ingest(sessions, remap), notes: 0 };
  }

  /* ---- the report ---- */

  function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function two(n) { return (n < 10 ? '0' : '') + n; }

  /**
   * Stamps are stored as UTC ISO strings so they sort and merge; the bench,
   * the calibration sticker and the technician's diary all run on local time.
   * The printed record converts, because a visit that happened at ten in the
   * evening must not read as five the next morning — or as the next day.
   */
  function when(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso).slice(0, 16).replace('T', ' ');
    return d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate()) +
      ' ' + two(d.getHours()) + ':' + two(d.getMinutes());
  }

  /**
   * A number the way it was measured or published, not the way it reads best.
   *
   * The board display rounds a supply rail to whole volts, which is right when
   * you are looking at a marker and wrong here: 564.8 V printed as "565 V" is
   * a report claiming a measurement nobody took, and limits of 508.5 … 621.5
   * printed as "509 … 622" misquote the manual they cite. Twelve significant
   * digits keeps every digit any bench meter can produce while shedding binary
   * float residue like 0.30000000000000004, which nobody measured either.
   */
  function num(v, signed) {
    if (v == null || isNaN(v)) return '—';
    var s = String(parseFloat(Number(v).toPrecision(12)));
    return signed && v > 0 ? '+' + s : s;
  }

  function measuredText(r) {
    var Parts = global.Parts;
    if (r.target === 'component') {
      // The value as it was typed, in the unit it was typed in. Routing it
      // through the display formatter trims to a few significant digits, and
      // 100.03 kΩ printed as "100 kΩ" is indistinguishable from nominal.
      if (r.measured != null && !isNaN(r.measured)) {
        return num(r.measured) + (r.unit ? ' ' + r.unit : '');
      }
      var unit = (r.spec && r.spec.unit) || r.unit;
      return Parts.format(r.base, r.quantity, unit);
    }
    return num(r.measured, true) + ' ' + (r.unit || 'V');
  }

  /**
   * The verdict an ESR reading actually earns, or null for any other reading.
   *
   * The parts list states no ESR, so these are stored unscored and judged
   * against the datasheet bound the reading carries — but the bound means a
   * different thing per family, and the report must make the same refusal
   * Caps.judgeESR makes on screen. Aluminium dries out and rising ESR is the
   * failure, so its gross limit yields a verdict. Tantalum ESR does not move
   * with age: its figure is for checking a replacement against, and a printed
   * pass or fail would invent a diagnosis the part cannot have.
   */
  function esrScore(r) {
    if (r.quantity !== 'esr' || !r.esrLimit) return null;
    var ratio = r.base / r.esrLimit;
    var type = global.Caps && global.Caps.type
      ? global.Caps.type({ desc: r.label || '' }) : null;
    if (type === 'TA') return { verdict: 'reference', ratio: ratio };
    return { verdict: ratio > 2 ? 'fail' : (ratio > 1 ? 'marginal' : 'pass'),
             ratio: ratio };
  }

  function expectedText(r) {
    if (r.target === 'component') {
      // The parts list states no ESR, so an ESR reading is judged against the
      // datasheet bound the reading carries. Without this the report showed
      // "not published" for a measurement that was in fact scored.
      if (r.quantity === 'esr') {
        if (r.esrLimit == null) return '<span class="dim">not published</span>';
        // A gross bound printed to four decimals claims a precision it does
        // not have.
        var bound = esc(r.esrLimit < 1 ? r.esrLimit.toFixed(3)
                                       : r.esrLimit.toFixed(1)) + ' Ω';
        var score = esrScore(r);
        // A tantalum's figure is its exact datasheet dissipation factor, not
        // a screening limit, and captioning it "gross limit" misstates what
        // the number beside it was compared against.
        if (score && score.verdict === 'reference') {
          return bound + '<br><span class="dim">datasheet figure — for ' +
            'comparing a replacement, not a health limit</span>';
        }
        return 'under ' + bound +
          '<br><span class="dim">gross limit for this value and rating</span>';
      }
      if (!r.spec) return '<span class="dim">not published</span>';
      return esc(global.Parts.format(r.spec.base, r.quantity, r.spec.unit)) +
        (global.Parts.toleranceText(r.spec)
          ? ' ' + esc(global.Parts.toleranceText(r.spec)) : '');
    }
    var e = r.expected;
    if (!e || e.nominal == null) return '<span class="dim">not published</span>';
    return esc(num(e.nominal, true) + ' ' + (r.unit || 'V')) +
      (e.lo != null ? '<br><span class="dim">' +
        esc(num(e.lo, true) + ' … ' + num(e.hi, true)) + '</span>' : '');
  }

  /**
   * A standalone HTML report for one unit: everything measured, everything
   * replaced, everything written down, across every board and every visit.
   *
   * Self-contained and printable, because it has to survive being emailed and
   * has to become a PDF without a toolchain. Assemblies are the outer grouping
   * and visits the inner one -- what is wanted months later is "what has been
   * done to the A18", not "what happened on the 14th".
   */
  Service.report = function (unit, opts) {
    var options = opts || {};
    var sessions = global.TestLog.sessions(unit.id);
    if (options.assembly) {
      sessions = sessions.filter(function (s) { return s.assembly === options.assembly; });
    }
    var assemblies = [];
    sessions.forEach(function (s) {
      if (assemblies.indexOf(s.assembly) < 0) assemblies.push(s.assembly);
    });
    // A note needs no session -- writing one is a single click while merely
    // inspecting a board -- so a board that only carries notes must still get
    // its section, or the report's claim to hold everything written down
    // quietly loses exactly the half most likely to go missing.
    Object.keys(global.Notes.dump([unit.id])).forEach(function (k) {
      var asm = k.split('/')[1];
      if (!asm) return;
      if (options.assembly && asm !== options.assembly) return;
      if (assemblies.indexOf(asm) < 0) assemblies.push(asm);
    });
    assemblies.sort();

    var totals = { readings: 0, testpoints: 0, components: 0, pinsweeps: 0,
                   pass: 0, marginal: 0, fail: 0, unscored: 0,
                   repairs: 0, replaced: 0, faulty: 0, notes: 0 };
    sessions.forEach(function (s) {
      s.readings.forEach(function (r) {
        totals.readings++;
        // The tiles must count what the tables print: an ESR reading scored
        // in its row and counted "no published limit" up here is a report
        // disagreeing with itself. A tantalum's reference reading carries no
        // health verdict, so it stays in the unscored tile.
        var e = esrScore(r);
        var v = e ? (e.verdict === 'reference' ? 'unscored' : e.verdict) : r.verdict;
        totals[v] = (totals[v] || 0) + 1;
        // A pin sweep is neither a test point nor a component measurement:
        // it is one reading holding many pin voltages, and folding it into
        // the test-point tile made the header claim points that were never
        // visited. It has its own section below, so it gets its own count.
        if (r.target === 'component') totals.components++;
        else if (r.target === 'pins') totals.pinsweeps++;
        else totals.testpoints++;
      });
    });
    // Repair rows are append-only -- finding a part bad and later replacing
    // it writes two rows -- so "faulty, not yet replaced" is a claim about a
    // ref's newest row, not about every row. Counting rows told the next
    // bench a known-bad part was still fitted after it had been changed.
    // Oldest session first so that, on equal stamps, the later row wins.
    var lastRepair = {};
    sessions.slice().reverse().forEach(function (s) {
      (s.repairs || []).forEach(function (r) {
        totals.repairs++;
        if (r.status === 'replaced') totals.replaced++;
        var k = (s.assembly || '') + '/' + r.ref;
        var prev = lastRepair[k];
        if (!prev || String(r.at || '') >= String(prev.at || '')) lastRepair[k] = r;
      });
    });
    Object.keys(lastRepair).forEach(function (k) {
      if (lastRepair[k].status === 'faulty') totals.faulty++;
    });

    var body = '';
    // The mono mark, inlined: this file gets saved, mailed and printed, so it
    // cannot reference an asset in the repo. The report is dark ink on white,
    // and the outlined mark is not for light backgrounds -- mono takes the
    // page's own ink colour through currentColor.
    body += '<header class="head">' +
      '<h1><svg class="mark" viewBox="0 0 32 32" fill="none" aria-hidden="true">' +
      '<rect x="2" y="2" width="28" height="28" stroke="currentColor" stroke-width="2"/>' +
      '<path d="M8.5 16.5 13.5 22 24 9.5" stroke="currentColor" stroke-width="3.4" ' +
      'stroke-linecap="square"/></svg>Service report</h1>' +
      '<dl class="ident">' +
      '<dt>Instrument</dt><dd>' + esc(unit.model || '5700A') + '</dd>' +
      '<dt>Serial</dt><dd class="serial">' +
        (unit.serial ? esc(unit.serial) : '<span class="warn">not recorded</span>') + '</dd>' +
      (unit.name ? '<dt>Name</dt><dd>' + esc(unit.name) + '</dd>' : '') +
      '<dt>Report</dt><dd>' + esc(when(new Date().toISOString())) + '</dd>' +
      '<dt>Covers</dt><dd>' + sessions.length + ' visit' + (sessions.length === 1 ? '' : 's') +
        (assemblies.length ? ' · ' + esc(assemblies.join(', ')) : '') + '</dd>' +
      '</dl></header>';

    body += '<section class="summary"><h2>Summary</h2><div class="tiles">' +
      tile(totals.readings, 'measurements') +
      tile(totals.testpoints, 'at test points') +
      tile(totals.components, 'on components') +
      (totals.pinsweeps ? tile(totals.pinsweeps,
        totals.pinsweeps === 1 ? 'pin sweep' : 'pin sweeps') : '') +
      tile(totals.pass, 'in tolerance', 'pass') +
      tile(totals.marginal, 'near limit', 'marginal') +
      tile(totals.fail, 'out of tolerance', 'fail') +
      tile(totals.unscored, 'no published limit') +
      tile(totals.replaced, 'parts replaced', totals.replaced ? 'fail' : '') +
      tile(totals.faulty, 'faulty, not yet replaced', totals.faulty ? 'marginal' : '') +
      '</div></section>';

    if (!sessions.length) {
      body += '<section><p class="dim">Nothing has been recorded against this ' +
        'instrument yet.</p></section>';
    }

    body += fitmentBlock(unit);

    assemblies.forEach(function (asm) {
      var mine = sessions.filter(function (s) { return s.assembly === asm; });
      body += '<section class="asm"><h2>' + esc(asm) + '</h2>';

      var repairs = [];
      mine.forEach(function (s) {
        (s.repairs || []).forEach(function (r) {
          repairs.push(Object.assign({}, r, { session: s }));
        });
      });
      if (repairs.length) body += repairTable(repairs);

      mine.forEach(function (s) { body += sessionBlock(s); });

      var notes = notesFor(unit.id, asm);
      if (notes.length) body += noteBlock(notes);
      body += '</section>';
    });

    return page(esc((unit.serial || 'unit') + ' — 5700A service report'), body);
  };

  function tile(n, label, tone) {
    return '<div class="tile' + (tone ? ' t-' + tone : '') + '">' +
      '<b>' + n + '</b><span>' + esc(label) + '</span></div>';
  }

  /**
   * What was plugged into the instrument, and every time it changed.
   *
   * It goes above the per-board sections because it qualifies all of them: a
   * rail measured with two boards pulled is not the same measurement as one
   * taken with the instrument whole, and the reader six months on has no other
   * way to know which they are looking at. Boards nobody recorded are left
   * out entirely rather than listed as present.
   *
   * Two tables, because they answer two questions. Boards travel between
   * calibrators when a fault is being isolated, and the report travels with
   * them: the first table is the configuration as it stands -- which boards
   * are out or substituted right now, since when, and why -- and the second
   * is every change, because what was pulled and whether the fault followed
   * it is the reasoning of the repair.
   */
  function fitmentBlock(unit) {
    var events = global.TestLog.fitmentLog ? global.TestLog.fitmentLog(unit.id) : [];
    if (!events.length) return '';

    var state = {};
    events.slice().reverse().forEach(function (e) { state[e.assembly] = e; });
    var out = Object.keys(state).filter(function (a) { return state[a].state === 'removed'; });
    var swapped = Object.keys(state).filter(function (a) { return state[a].state === 'swapped'; });
    var byNumber = function (a, b) {
      return parseInt(a.replace(/^\D+/, ''), 10) - parseInt(b.replace(/^\D+/, ''), 10);
    };

    var head = out.length
      ? '<strong>' + esc(out.sort(byNumber).join(', ')) + '</strong> out of the instrument'
      : 'All recorded boards fitted';
    if (swapped.length) {
      head += ' · <strong>' + esc(swapped.sort(byNumber).join(', ')) +
              '</strong> swapped for another board';
    }

    var html = '<section class="asm"><h2>Instrument configuration</h2>' +
      '<p class="meta">' + head + ' — as last recorded ' +
      esc(when(events[0].at)) + '</p>';

    var attention = out.concat(swapped).sort(byNumber);
    if (attention.length) {
      html += '<table class="fitment"><thead><tr><th>Board</th><th>State</th>' +
        '<th>Since</th><th>Why</th></tr></thead><tbody>' +
        attention.map(function (a) {
          var e = state[a];
          return '<tr><td class="ref">' + esc(a) + '</td>' +
            '<td>' + fitTag(e.state) + '</td>' +
            '<td class="dim">' + esc(when(e.at)) + '</td>' +
            '<td>' + esc(e.note || '') + '</td></tr>';
        }).join('') + '</tbody></table>';
    }

    return html + '<h4>Changes</h4>' +
      '<table class="fitment"><thead><tr><th>When</th><th>Board</th>' +
      '<th>Change</th><th>Why</th></tr></thead><tbody>' +
      events.map(function (e) {
        return '<tr><td class="when">' + esc(when(e.at)) + '</td>' +
          '<td class="ref">' + esc(e.assembly) + '</td>' +
          '<td>' + fitTag(e.state) + '</td>' +
          '<td>' + esc(e.note || '') + '</td></tr>';
      }).join('') +
      '</tbody></table></section>';
  }

  /**
   * Fitment states in the report's own vocabulary. The app stylesheet's
   * classes do not exist in this file, so a state marked with one would
   * print in plain ink -- and a board that is out is the one state this
   * section exists to make impossible to miss.
   */
  function fitTag(state) {
    var cls = state === 'removed' ? 'g-fail'
            : state === 'swapped' ? 'g-sub' : 'g-pass';
    var word = state === 'removed' ? 'removed'
             : state === 'swapped' ? 'swapped' : 'fitted';
    return '<span class="tag ' + cls + '">' + word + '</span>';
  }

  function repairTable(repairs) {
    var words = { suspect: 'Suspect', faulty: 'Faulty', replaced: 'Replaced',
                  removed: 'Removed' };
    return '<h3>Parts</h3><table class="rep"><thead><tr>' +
      '<th>Ref</th><th>State</th><th>Symptom</th><th>Removed</th><th>Fitted</th>' +
      '<th>When</th></tr></thead><tbody>' +
      repairs.map(function (r) {
        var fitted = r.fitted || {};
        var removed = r.removed || {};
        return '<tr class="s-' + esc(r.status) + '">' +
          '<td class="ref">' + esc(r.ref) + '</td>' +
          '<td><span class="tag g-' + esc(r.status) + '">' +
            esc(words[r.status] || r.status) + '</span></td>' +
          '<td>' + esc(r.symptom || '') + (r.note ? '<br><span class="dim">' +
            esc(r.note) + '</span>' : '') + '</td>' +
          '<td>' + partCell(removed) + '</td>' +
          '<td>' + (r.status === 'replaced' ? partCell(fitted) +
            (fitted.substitute ? '<br><span class="tag g-sub">substitute</span>' : '')
            : '<span class="dim">—</span>') + '</td>' +
          '<td class="dim">' + esc(when(r.at)) + '</td></tr>';
      }).join('') + '</tbody></table>';
  }

  function partCell(p) {
    if (!p || (!p.desc && !p.fluke && !p.mfrPart)) return '<span class="dim">—</span>';
    var html = esc(p.desc || '') +
      (p.fluke ? '<br><span class="dim">Fluke ' + esc(p.fluke) + '</span>' : '') +
      (p.mfrPart ? '<br><span class="dim">' + esc(p.mfrPart) + '</span>' : '');
    // A capacitor swap records what the new part measured before it went in --
    // the third measurement of the round, and the only one that is not a
    // reading in the log, so it prints here or nowhere.
    var bench = [];
    if (p.measuredUF) {
      bench.push('measured ' + esc(p.measuredUF) + ' µF' +
        (p.deltaPct != null ? ' (' + (p.deltaPct > 0 ? '+' : '') + esc(p.deltaPct) + '%)' : ''));
    }
    if (p.esr) bench.push('ESR ' + esc(p.esr) + ' Ω');
    if (p.ratedV) bench.push(esc(p.ratedV) + ' V rated');
    if (bench.length) {
      html += '<br><span class="dim">' + bench.join(' · ') + '</span>';
    }
    return html;
  }

  function sessionBlock(s) {
    var html = '<div class="visit"><h3>Visit of ' + esc(when(s.startedAt)) + '</h3>';
    var meta = [];
    // Which board, before who measured it and on what. A visit names the
    // assembly slot; this names the object that was in it, and the two part
    // company as soon as a board is swapped -- which on a bench is often.
    if (s.assemblySerial || s.assemblyRev) {
      meta.push(esc(s.assembly || 'Board') + ' board ' +
        (s.assemblySerial ? '<b>' + esc(s.assemblySerial) + '</b>' : '(serial not recorded)') +
        (s.assemblyRev ? ' rev ' + esc(s.assemblyRev) : ''));
    }
    if (s.technician) meta.push('Technician: ' + esc(s.technician));
    if (s.meter) meta.push('Meter: ' + esc(s.meter));
    if (s.lineVoltage) meta.push('Line: ' + esc(s.lineVoltage));
    if (s.ambient) meta.push('Ambient: ' + esc(s.ambient));
    if (meta.length) html += '<p class="meta">' + meta.join(' · ') + '</p>';
    if (s.notes) html += '<p class="visit-note">' + esc(s.notes) + '</p>';
    // Notes about the visit itself. They carry what the reading tables cannot:
    // what was tried, what was ruled out, what the next person should start on.
    if ((s.log || []).length) {
      html += '<div class="visit-log"><h4>Session notes</h4>' +
        s.log.map(function (n) {
          return '<p class="visit-note"><span class="dim">' +
            esc(when(n.at)) + (n.author ? ' · ' + esc(n.author) : '') + '</span><br>' +
            esc(n.text) + '</p>';
        }).join('') + '</div>';
    }

    var sweeps = s.readings.filter(function (r) { return r.target === 'pins'; });
    var tps = s.readings.filter(function (r) {
      return r.target !== 'component' && r.target !== 'pins';
    });
    var comps = s.readings.filter(function (r) { return r.target === 'component'; });
    if (tps.length) html += '<h4>Test points</h4>' + readingTable(tps, false);
    if (comps.length) html += '<h4>Components</h4>' + readingTable(comps, true);
    if (sweeps.length) html += '<h4>Pin voltages</h4>' + pinTable(sweeps);
    if (!tps.length && !comps.length && !sweeps.length && !(s.repairs || []).length) {
      html += '<p class="dim">No measurements recorded on this visit.</p>';
    }
    return html + '</div>';
  }

  /**
   * Pin sweeps, one block per sweep.
   *
   * Not a row in the readings table: a sweep is up to sixty-four numbers taken
   * at one moment, and flattening it into that table would bury the readings
   * that do have a published limit under a wall of ones that never can. The
   * condition is printed with each block because without it the numbers cannot
   * be compared -- to the next sweep or to anything else.
   */
  function pinTable(sweeps) {
    return sweeps.map(function (r) {
      var cells = (r.pins || []).map(function (p) {
        // Pins recorded here are numbers, but imported sessions arrive
        // verbatim, so a pin from a file is user text like everything else.
        return '<td><span class="pn">' + esc(p.pin) + '</span>' +
          esc(num(p.v, true)) + '</td>';
      }).join('');
      return '<div class="pinblock">' +
        '<div class="pinhead"><b>' + esc(r.ref) + '</b>' +
        (r.condition ? ' — ' + esc(r.condition) : '') +
        (r.refPoint ? ' <span class="dim">referenced to ' + esc(r.refPoint) + '</span>' : '') +
        ' <span class="dim">' + esc(when(r.at)) + '</span></div>' +
        '<table class="pins"><tr>' + cells + '</tr></table>' +
        (r.note ? '<div class="dim">' + esc(r.note) + '</div>' : '') +
        '</div>';
    }).join('');
  }

  function readingTable(rows, isComponent) {
    var words = { pass: 'in tolerance', marginal: 'near limit',
                  fail: 'OUT OF TOLERANCE', unscored: 'recorded' };
    return '<table class="rd"><thead><tr>' +
      '<th>Ref</th><th>' + (isComponent ? 'Part' : 'Signal') + '</th>' +
      (isComponent ? '<th>Quantity</th><th>Where</th>' : '<th>Mode</th>') +
      '<th>Measured</th><th>' + (isComponent ? 'Parts list' : 'Expected') + '</th>' +
      '<th>Off nominal</th><th>Result</th><th>Note</th></tr></thead><tbody>' +
      rows.map(function (r) {
        return '<tr>' +
          '<td class="ref">' + esc(r.ref) + '</td>' +
          '<td>' + esc(r.label || '') + '</td>' +
          '<td>' + (isComponent
            ? esc((global.Parts.quantity(r.quantity) || {}).label || r.quantity || '')
            : esc(r.stateLabel || '')) + '</td>' +
          // Its own column, because whether a capacitor was read in circuit or
          // on the bench is the difference between a screening number and a
          // verdict, and a reader scanning the table should not have to infer
          // it from a note.
          (isComponent
            ? '<td>' + (r.inCircuit ? 'in circuit' : 'out of circuit') + '</td>'
            : '') +
          '<td class="num">' + esc(measuredText(r)) + '</td>' +
          '<td class="num">' + expectedText(r) + '</td>' +
          '<td class="num">' + (r.pctOffNominal == null ? '<span class="dim">—</span>'
            : esc((r.pctOffNominal > 0 ? '+' : '') + r.pctOffNominal.toFixed(2) + '%')) + '</td>' +
          '<td>' + (function () {
            // An ESR reading was stored 'unscored' because the parts list
            // cannot score it; the bound can, so the verdict is worked out here
            // rather than left blank in the printed record. What it works out
            // to depends on the capacitor's family -- see esrScore.
            var e = esrScore(r);
            if (e && e.verdict === 'reference') {
              return '<span class="tag g-unscored">reference</span> ' +
                '<span class="dim">' + e.ratio.toFixed(1) + '× datasheet</span>';
            }
            if (e) {
              return '<span class="tag g-' + e.verdict + '">' +
                esc(words[e.verdict] || e.verdict) +
                '</span> <span class="dim">' + e.ratio.toFixed(1) + '×</span>';
            }
            return '<span class="tag g-' + esc(r.verdict) + '">' +
              esc(words[r.verdict] || r.verdict) + '</span>';
          }()) + '</td>' +
          '<td>' + esc(r.note || '') + '</td></tr>';
      }).join('') + '</tbody></table>';
  }

  function notesFor(unitId, assembly) {
    var all = global.Notes.dump([unitId]);
    var prefix = unitId + '/' + assembly + '/';
    return Object.keys(all).filter(function (k) { return k.indexOf(prefix) === 0; })
      .map(function (k) { return { ref: k.slice(prefix.length), notes: all[k] }; })
      .sort(function (a, b) { return a.ref < b.ref ? -1 : 1; });
  }

  function noteBlock(groups) {
    return '<h3>Notes</h3><table class="nt"><tbody>' + groups.map(function (g) {
      return '<tr><td class="ref">' + esc(g.ref) + '</td><td>' +
        g.notes.map(function (n) {
          // Who wrote it prints beside when, same as the session log: on a
          // shared bench a note without its author is half an observation.
          return '<div class="note"><span class="dim">' + esc(when(n.at)) +
            (n.author ? ' · ' + esc(n.author) : '') + '</span> ' +
            esc(n.text) + '</div>';
        }).join('') + '</td></tr>';
    }).join('') + '</tbody></table>';
  }

  /**
   * One file, no links out. A report that fetches a stylesheet is a report
   * that renders as a wall of text on the machine it gets forwarded to.
   */
  function page(title, body) {
    return '<!doctype html>\n<html lang="en"><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>' + title + '</title><style>' + CSS + '</style></head>' +
      '<body>' + body +
      '<footer>Generated by Fluke 5700A Atlas. ' +
      'Expected values are quoted from the 5700A/5720A Service Manual; ' +
      'parts-list values are from the assembly parts tables.</footer>' +
      '</body></html>\n';
  }

  var CSS = [
    ':root{--ink:#15181d;--dim:#6b7480;--line:#d9dde3;--bg:#fff;',
    '--pass:#1c7a48;--marg:#8a6300;--fail:#a8202f;--accent:#1b4f8a}',
    '*{box-sizing:border-box}',
    'body{margin:0;padding:32px;font:14px/1.5 -apple-system,BlinkMacSystemFont,',
    '"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:var(--ink);background:var(--bg)}',
    'h1{font-size:24px;margin:0 0 4px;display:flex;align-items:center;gap:9px}',
    'h1 .mark{width:22px;height:22px;flex:0 0 auto}',
    'h2{font-size:18px;margin:32px 0 10px;',
    'padding-bottom:6px;border-bottom:2px solid var(--ink)}',
    'h3{font-size:15px;margin:20px 0 8px}h4{font-size:13px;margin:14px 0 6px;',
    'text-transform:uppercase;letter-spacing:.06em;color:var(--dim)}',
    '.pinblock{margin:10px 0 14px;break-inside:avoid}',
    '.pinhead{font-size:12px;margin-bottom:4px}',
    'table.pins{border-collapse:collapse;font-size:11px}',
    'table.pins td{border:1px solid var(--line);padding:3px 6px;text-align:right;',
    'font-variant-numeric:tabular-nums;white-space:nowrap}',
    'table.pins .pn{color:var(--dim);margin-right:6px}',
    '.head{border-bottom:3px solid var(--ink);padding-bottom:14px}',
    '.ident{display:grid;grid-template-columns:max-content 1fr;gap:2px 16px;margin:10px 0 0}',
    '.ident dt{color:var(--dim);font-size:12px;text-transform:uppercase;letter-spacing:.05em}',
    '.ident dd{margin:0}',
    '.serial{font-weight:700;font-size:16px;font-family:ui-monospace,Menlo,monospace}',
    '.warn{color:var(--fail);font-weight:600}',
    '.tiles{display:flex;flex-wrap:wrap;gap:10px}',
    '.tile{border:1px solid var(--line);border-radius:6px;padding:8px 14px;min-width:96px}',
    '.tile b{display:block;font-size:22px;line-height:1.1}',
    '.tile span{font-size:11px;color:var(--dim)}',
    '.tile.t-pass b{color:var(--pass)}.tile.t-marginal b{color:var(--marg)}',
    '.tile.t-fail b{color:var(--fail)}',
    'table{width:100%;border-collapse:collapse;margin:6px 0 14px;font-size:13px}',
    'th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.05em;',
    'color:var(--dim);border-bottom:1px solid var(--line);padding:5px 8px}',
    'td{padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}',
    'td.num{text-align:right;font-family:ui-monospace,Menlo,monospace;white-space:nowrap}',
    'td.ref{font-family:ui-monospace,Menlo,monospace;font-weight:600;white-space:nowrap}',
    '.dim{color:var(--dim);font-size:12px}',
    '.tag{display:inline-block;padding:1px 7px;border-radius:10px;font-size:11px;',
    'font-weight:600;white-space:nowrap;border:1px solid currentColor}',
    '.g-pass{color:var(--pass)}.g-marginal{color:var(--marg)}.g-fail{color:var(--fail)}',
    '.g-unscored{color:var(--dim)}.g-replaced{color:var(--fail)}',
    '.g-faulty{color:var(--marg)}.g-suspect{color:var(--dim)}.g-sub{color:var(--accent)}',
    '.g-removed{color:var(--marg)}',
    '.visit{margin:14px 0 0;padding-left:14px;border-left:3px solid var(--line)}',
    '.meta,.visit-note{color:var(--dim);font-size:12px;margin:2px 0 8px}',
    // pre-wrap, because notes are written in textareas: a fourteen-line pin
    // rundown collapsed into one run-on line is a note nobody can read back.
    '.visit-note{color:var(--ink);white-space:pre-wrap}',
    '.note{margin:0 0 4px;white-space:pre-wrap}',
    'footer{margin-top:36px;padding-top:12px;border-top:1px solid var(--line);',
    'color:var(--dim);font-size:11px}',
    // The footer flows once at the end rather than fixing to the page bottom:
    // in paged media a fixed element repeats over the content of every full
    // page, and this file's whole purpose is to become a printed PDF.
    '@media print{body{padding:0;font-size:11px}h2{page-break-after:avoid}',
    'table{page-break-inside:auto}tr{page-break-inside:avoid}',
    '.visit{page-break-inside:avoid}}'
  ].join('');

  global.Service = Service;
})(window);
