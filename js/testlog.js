/*
 * testlog.js — measurement sessions, repairs, scoring and export.
 *
 * A session is one visit to one board of one instrument: who measured it,
 * when, on which meter, every reading taken and every part touched. Sessions
 * are kept so that the same test point can be compared across visits -- a
 * supply that has been sliding from +565 V to +520 V over three years is still
 * "in tolerance" every single time, and only the history shows the problem.
 *
 * Everything here hangs off a unit, meaning one physical calibrator with one
 * serial number. That is not bookkeeping: two 5700As on the same bench have
 * different histories, and a record that cannot say which instrument it
 * describes is not a service record.
 *
 * Three kinds of thing get recorded:
 *
 *   readings   what a test point measured, scored against the manual
 *   readings   what a component measured, scored against the parts list where
 *              the parts list states a value -- same list, because they are
 *              the same act and belong on one timeline
 *   repairs    what was found faulty and what went in its place
 *
 * Storage is localStorage plus explicit export, because a file:// page cannot
 * rely on storage surviving, and because a service record belongs in a file
 * next to the manuals rather than inside a browser profile.
 */
(function (global) {
  'use strict';

  var KEY = 'fluke5700a.testlog.v2';
  var LEGACY = 'fluke5700a.testlog.v1';
  var TP = global.TestPoints;

  var db = load();

  /*
   * The raw text this window last knew the key to hold. Nothing is re-read
   * from it: it exists so that absorbExternal() can tell "another window
   * wrote" from "nothing has moved" without parsing, because a linked view
   * calls it twice a second and must not merge and redraw on an unchanged
   * store. persist() keeps it in step so this window's own writes do not come
   * back as news.
   */
  var lastRaw = rawStore();

  function rawStore() {
    try { return global.localStorage.getItem(KEY); } catch (err) { return null; }
  }

  function load() {
    var raw = null;
    try {
      raw = global.localStorage.getItem(KEY);
    } catch (err) {
      console.warn('testlog: storage unavailable, session is in-memory only', err);
      return adopt();
    }
    var parsed = null;
    if (raw != null) {
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        // A blob that does not parse is not the same thing as no storage: the
        // record is still in it, one write away from being destroyed. The raw
        // text goes somewhere persist() cannot reach before anything else
        // happens, so the history can be recovered by hand instead of being
        // overwritten by the first thing recorded after the damage.
        try { global.localStorage.setItem(KEY + '.bak', raw); } catch (e2) {}
        console.warn('testlog: stored log is corrupt; raw copy kept under ' +
                     KEY + '.bak', err);
      }
    }
    if (parsed && parsed.sessions) {
      // Added after logs already existed, so it has to be tolerated as absent
      // rather than assumed present.
      if (!parsed.fitment) parsed.fitment = [];
      parsed.sessions.forEach(function (s) { rescoreEsr(s.readings); });
      return parsed;
    }
    return adopt();
  }

  /**
   * Score ESR readings that carry their bound but no verdict.
   *
   * The parts list states no ESR, so these are judged against the datasheet
   * bound the reading itself carries, with the same thresholds the printed
   * report applies: twice the bound is a fail, over it is marginal. Readings
   * recorded before ESR was scored at record time sit in old stores and old
   * exports as 'unscored' with the bound right beside them, and left as
   * written they keep the CSV, the marker dots and the summary tiles
   * contradicting the report rows forever -- so the verdict is filled in
   * wherever such a reading enters this store.
   */
  function rescoreEsr(list) {
    (list || []).forEach(function (r) {
      if (!r || r.verdict !== 'unscored' || r.quantity !== 'esr') return;
      if (r.esrLimit == null || !(r.esrLimit > 0) || r.base == null || isNaN(r.base)) return;
      r.verdict = r.base > r.esrLimit * 2 ? 'fail'
                : r.base > r.esrLimit ? 'marginal' : 'pass';
    });
  }

  /**
   * Bring a pre-unit log forward.
   *
   * Each old session names its instrument in a free-text field; units.js has
   * already turned those into units, so the join is on the serial. Sessions
   * that never named one go to whichever unit is active, which is the only
   * answer available and is why the panel says so afterwards rather than
   * quietly assuming it got it right.
   *
   * The v1 key is read and left in place. A migration that cannot be undone
   * had better be right first time, and this one is inferring.
   */
  function adopt() {
    var fresh = { version: 2, sessions: [], activeId: null, adopted: 0, fitment: [] };
    var legacy = null;
    try {
      legacy = JSON.parse(global.localStorage.getItem(LEGACY));
    } catch (err) { return fresh; }
    if (!legacy || !legacy.sessions || !legacy.sessions.length) return fresh;

    var units = global.Units;
    var fallback = units ? units.ensure().id : null;
    legacy.sessions.forEach(function (s) {
      var serial = (s.instrumentSerial || '').trim().toLowerCase();
      var match = serial && units && units.all().find(function (u) {
        return (u.serial || '').trim().toLowerCase() === serial;
      });
      var copy = Object.assign({}, s);
      copy.unitId = match ? match.id : fallback;
      copy.repairs = [];
      (copy.readings || []).forEach(function (r) {
        // Everything the old log could hold was a voltage at a test point.
        if (!r.quantity) r.quantity = 'voltage';
        if (!r.target) r.target = 'testpoint';
      });
      fresh.sessions.push(copy);
      fresh.adopted++;
    });
    fresh.activeId = legacy.activeId || null;
    return fresh;
  }

  /*
   * Two tabs on one instrument share this key, and a write is whole-store:
   * without looking first, whichever tab saved last would erase everything the
   * other had recorded since this one loaded. So every write re-reads the key
   * and folds what it finds into the cache by id before saving. Additions
   * always survive that. A deletion cannot be told from the other tab's
   * addition by looking at the data, so the ids this tab has removed are
   * remembered and kept out of the merge -- a deletion made in another tab can
   * still be undone by this one's next write, which is the survivable
   * direction to be wrong in.
   */
  var removed = {};

  function forget(id) { removed[id] = true; }

  function mergeStore(fresh) {
    if (!fresh || !fresh.sessions || !fresh.sessions.forEach) return;
    var have = {};
    db.sessions.forEach(function (s) { have[s.id] = s; });
    fresh.sessions.forEach(function (s) {
      if (!s || !s.id || removed[s.id]) return;
      if (!have[s.id]) {
        rescoreEsr(s.readings);
        db.sessions.push(s);
        have[s.id] = s;
        return;
      }
      mergeSessionItems(have[s.id], s);
    });
    var seen = {};
    db.fitment.forEach(function (e) { seen[e.id] = true; });
    (fresh.fitment || []).forEach(function (e) {
      if (e && e.id && !seen[e.id] && !removed[e.id]) db.fitment.push(e);
    });
  }

  /**
   * Fold one incoming session's readings, repairs and notes into the local
   * session with the same id, each list matched by its own item ids. Returns
   * how many items actually arrived, so callers can tell a merge that changed
   * something from one that did not.
   */
  function mergeSessionItems(mine, theirs) {
    var count = 0;
    ['readings', 'repairs', 'log'].forEach(function (field) {
      var incoming = theirs[field];
      if (!incoming || !incoming.forEach) return;
      var list = mine[field] = mine[field] || [];
      var seen = {};
      list.forEach(function (x) { if (x && x.id) seen[x.id] = true; });
      incoming.forEach(function (x) {
        if (!x || !x.id || seen[x.id] || removed[x.id]) return;
        seen[x.id] = true;
        list.push(x);
        count++;
      });
      if (field === 'readings') rescoreEsr(list);
    });
    return count;
  }

  /**
   * Write the log, and make a failure impossible to miss.
   *
   * A warning on a console nobody has open is not a report. Storage fills up,
   * and when it did the reading was confirmed by a toast, added to the table
   * and counted in the session header while never reaching disk -- so it
   * survived until the next reload and no further. A measurement taken with
   * one hand on a probe beside a charged 1100 V supply is not something to
   * lose quietly, so this says so on screen, every time, until there is room.
   */
  function persist() {
    try {
      var fresh = null;
      try { fresh = JSON.parse(global.localStorage.getItem(KEY)); } catch (err2) { fresh = null; }
      mergeStore(fresh);
      var text = JSON.stringify(db);
      global.localStorage.setItem(KEY, text);
      lastRaw = text;
      TestLog.storageFailed = false;
    } catch (err) {
      console.warn('testlog: could not persist', err);
      TestLog.storageFailed = true;
      global.BoardExplorer.emit('storage', { key: KEY, error: String(err) });
    }
  }

  function uid(prefix) {
    return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  function unitId() {
    return global.Units ? global.Units.ensure().id : null;
  }

  function byNewest(a, b) { return a.startedAt < b.startedAt ? 1 : -1; }

  var TestLog = {
    /**
     * Re-read another window's writes on demand. Registered on the storage
     * event below; also called by a linked view, which cannot wait for an
     * event that may never come. See absorbExternal.
     */
    absorbExternal: absorbExternal,

    /** Sessions for one unit, newest first. Defaults to the unit on screen. */
    sessions: function (id) {
      var want = id === undefined ? unitId() : id;
      return db.sessions.filter(function (s) { return s.unitId === want; }).sort(byNewest);
    },

    /** Every session of every unit — for export and for nothing else. */
    allSessions: function () { return db.sessions.slice().sort(byNewest); },

    /**
     * The open session, but only if it belongs to the unit being worked on.
     * Switching units must not leave the previous unit's session accepting
     * readings, which is the whole point of scoping them.
     */
    active: function () {
      var s = db.sessions.find(function (x) { return x.id === db.activeId; });
      return s && s.unitId === unitId() ? s : null;
    },

    setActive: function (id) {
      db.activeId = id;
      persist();
      global.BoardExplorer.emit('testlog', { active: id });
    },

    start: function (meta) {
      var unit = global.Units ? global.Units.ensure() : null;
      var session = {
        id: uid('s'),
        unitId: unit ? unit.id : null,
        assembly: meta.assembly,
        startedAt: new Date().toISOString(),
        // Kept in step with the unit so an exported session reads on its own,
        // without having to resolve a unit id to know whose board it was.
        instrumentSerial: meta.instrumentSerial || (unit ? unit.serial : '') || '',
        // Which physical board, as distinct from which instrument. A PCA is
        // field-replaceable, and swapping a suspect board for a known-good one
        // is the fastest way to tell whether a fault lives on the board or in
        // what feeds it -- so the board fitted at the start of a visit is not
        // necessarily the one fitted at the end of the last. Without this, a
        // reading filed against "A16" says which *design* was measured and
        // never which *object*, and six months on that is the difference
        // between a diagnosis and a note. The revision rides along because
        // Fluke changed values and topology between revs, so a limit that
        // applies to one board may not apply to the next.
        assemblySerial: meta.assemblySerial || '',
        assemblyRev: meta.assemblyRev || '',
        technician: meta.technician || '',
        lineVoltage: meta.lineVoltage || '',
        ambient: meta.ambient || '',
        meter: meta.meter || '',
        notes: meta.notes || '',
        readings: [],
        repairs: []
      };
      db.sessions.push(session);
      db.activeId = session.id;
      persist();
      global.BoardExplorer.emit('testlog', { active: session.id });
      return session;
    },

    updateMeta: function (id, patch) {
      var s = db.sessions.find(function (x) { return x.id === id; });
      if (!s) return null;
      Object.keys(patch).forEach(function (k) { s[k] = patch[k]; });
      persist();
      global.BoardExplorer.emit('testlog', { active: db.activeId });
      return s;
    },

    remove: function (id) {
      forget(id);
      db.sessions = db.sessions.filter(function (s) { return s.id !== id; });
      if (db.activeId === id) {
        var mine = TestLog.sessions();
        db.activeId = mine.length ? mine[0].id : null;
      }
      persist();
      global.BoardExplorer.emit('testlog', { active: db.activeId });
    },

    /**
     * A free-form note about the visit rather than about one part.
     *
     * The per-component notes answer "what is wrong with C13". These answer the
     * things that belong to the whole session and have had nowhere to live:
     * what state the instrument was in, what was tried and abandoned, what the
     * next person should start with. Kept as a list with timestamps rather than
     * one growing string, so the order of events survives.
     *
     * The older single `notes` string is left alone and still shown; it was
     * whatever someone typed when the session was started.
     */
    addSessionNote: function (text, author) {
      var session = TestLog.active();
      if (!session || !text || !text.trim()) return null;
      session.log = session.log || [];
      var note = {
        id: uid('n'),
        at: new Date().toISOString(),
        text: text.trim(),
        author: author || session.technician || ''
      };
      session.log.push(note);
      persist();
      global.BoardExplorer.emit('testlog', { note: note });
      return note;
    },

    removeSessionNote: function (id) {
      forget(id);
      db.sessions.forEach(function (s) {
        if (!s.log) return;
        s.log = s.log.filter(function (n) { return n.id !== id; });
      });
      persist();
      global.BoardExplorer.emit('testlog', {});
    },

    /* ---- readings ---- */

    /**
     * Record a measurement at a test point or probe point, scored against
     * whichever of its published expectations applies.
     */
    record: function (target, measured, opts) {
      var session = TestLog.active();
      if (!session) return null;
      var options = opts || {};
      var states = TP.states(target);
      var state = states[options.stateIndex || 0] || null;
      var result = TP.evaluate(state, measured);
      return push(session, {
        id: uid('r'),
        target: 'testpoint',
        ref: target.ref || target.id,
        label: target.signal || target.label || target.ref || target.id,
        quantity: 'voltage',
        refPoint: target.refPoint || null,
        at: new Date().toISOString(),
        measured: measured,
        unit: target.unit || 'V',
        base: measured,
        stateIndex: options.stateIndex || 0,
        stateLabel: state ? state.label : null,
        setup: state ? state.setup || null : null,
        expected: state ? {
          nominal: (TP.range(state) || {}).nominal,
          lo: (TP.range(state) || {}).lo,
          hi: (TP.range(state) || {}).hi,
          source: state.source || null
        } : null,
        verdict: result ? result.verdict : 'unscored',
        deviation: result ? result.deviation : null,
        pctOffNominal: result ? result.pctOffNominal : null,
        note: options.note || ''
      });
    },

    /**
     * Record a measurement on a component -- resistance, capacitance, ESR,
     * forward drop, whatever was put on it.
     *
     * Scored against the parts list where the parts list states a value, and
     * left unscored where it does not, which is most of the BOM. An unscored
     * reading is still worth having: "U7 pin 6 sat at 4 V" is the observation
     * the next person needs even though nothing published says what it should
     * have been.
     *
     * `inCircuit` is recorded because it changes what the number means. A
     * resistor measured in circuit reads low through everything in parallel
     * with it, and a report that does not say which way it was measured is
     * quietly misleading.
     */
    recordComponent: function (item, opts) {
      var session = TestLog.active();
      if (!session || !item) return null;
      var options = opts || {};
      var Parts = global.Parts;
      var value = options.value;
      if (value == null || isNaN(value)) return null;
      var quantity = options.quantity || 'resistance';
      var unit = options.unit == null ? '' : options.unit;
      var base = Parts.toBase(value, unit);
      var spec = Parts.spec(item);
      // Only compare like with like: a capacitance reading says nothing about
      // a resistor's printed value.
      if (spec && spec.quantity !== quantity) spec = null;
      var scored = spec ? Parts.compare(spec, base) : null;

      var reading = {
        id: uid('r'),
        target: 'component',
        ref: item.ref,
        label: item.desc || item.ref,
        quantity: quantity,
        at: new Date().toISOString(),
        measured: value,
        unit: unit,
        base: base,
        inCircuit: !!options.inCircuit,
        // The whole tolerance is stored, not just the symmetrical per cent: a
        // "+30-20%" electrolytic or a "+-0.1PF" ceramic has no tolerancePct,
        // and a reading that kept only that field would lose what it was
        // judged against the moment it was written.
        spec: spec ? { base: spec.base, unit: spec.unit, text: spec.text,
                       quantity: spec.quantity,
                       tolerancePct: spec.tolerancePct,
                       tolPctHi: spec.tolPctHi, tolPctLo: spec.tolPctLo,
                       toleranceAbs: spec.toleranceAbs } : null,
        expected: null,
        // An ESR reading is judged against a datasheet bound rather than the
        // parts list, which states no ESR. The bound travels with the reading
        // so an exported log can be read without the dataset beside it.
        esrLimit: options.esrLimit == null ? null : options.esrLimit,
        verdict: scored ? scored.verdict : 'unscored',
        deviation: spec ? base - spec.base : null,
        pctOffNominal: scored ? scored.pctOffNominal : null,
        note: options.note || ''
      };
      // Scored at record time rather than at print time, so the row, the
      // dots and the CSV all say the same thing about the same measurement.
      rescoreEsr([reading]);
      return push(session, reading);
    },

    /**
     * Across sessions, like updateRepair below: the readings on a part's card
     * are routinely from an older session than the open one, since returning
     * to a board adopts its newest.
     */
    updateReading: function (readingId, patch) {
      var found = null;
      db.sessions.forEach(function (s) {
        (s.readings || []).forEach(function (r) { if (r.id === readingId) found = r; });
      });
      if (!found) return null;
      Object.keys(patch).forEach(function (k) { found[k] = patch[k]; });
      persist();
      global.BoardExplorer.emit('testlog', { reading: found });
      return found;
    },

    /**
     * Across sessions, like removeRepair below.
     *
     * It used to filter only the open session, so the remove link on a reading
     * from an earlier visit did nothing at all -- and because it persisted and
     * emitted anyway, the panel re-rendered and looked like it had tried. The
     * readings on a part's card are routinely from an older session than the
     * open one, since returning to a board adopts its newest, so "nothing
     * happens, forever, with no error" was the ordinary case rather than an
     * edge of one.
     */
    removeReading: function (readingId) {
      forget(readingId);
      db.sessions.forEach(function (s) {
        s.readings = (s.readings || []).filter(function (r) { return r.id !== readingId; });
      });
      persist();
      global.BoardExplorer.emit('testlog', {});
    },

    /* ---- repairs ---- */

    /**
     * Record that a part was found suspect, confirmed faulty, or replaced.
     *
     * Status and replacement are separate on purpose. A part can be known bad
     * with the replacement still on order, and a part can be replaced without
     * ever having been faulty -- recapping a supply is exactly that. Collapsing
     * the two would make both of those unrecordable.
     */
    addRepair: function (item, opts) {
      var session = TestLog.active();
      if (!session || !item) return null;
      var options = opts || {};
      session.repairs = session.repairs || [];
      var repair = {
        id: uid('x'),
        ref: item.ref,
        at: new Date().toISOString(),
        status: options.status || 'suspect',
        symptom: options.symptom || '',
        // What came out is known already -- it is the part the manual says is
        // there. Prefilling it means correcting a line rather than typing one,
        // and it is right far more often than it is wrong.
        removed: options.removed || {
          desc: item.desc || '', fluke: item.fluke || '', mfrPart: item.mfrPart || ''
        },
        fitted: options.fitted || { desc: '', fluke: '', mfrPart: '', substitute: false },
        note: options.note || ''
      };
      session.repairs.push(repair);
      persist();
      global.BoardExplorer.emit('testlog', { repair: repair });
      return repair;
    },

    updateRepair: function (repairId, patch) {
      var found = null;
      db.sessions.forEach(function (s) {
        (s.repairs || []).forEach(function (r) { if (r.id === repairId) found = r; });
      });
      if (!found) return null;
      Object.keys(patch).forEach(function (k) { found[k] = patch[k]; });
      persist();
      global.BoardExplorer.emit('testlog', { repair: found });
      return found;
    },

    removeRepair: function (repairId) {
      forget(repairId);
      db.sessions.forEach(function (s) {
        s.repairs = (s.repairs || []).filter(function (r) { return r.id !== repairId; });
      });
      persist();
      global.BoardExplorer.emit('testlog', {});
    },

    /**
     * Every repair on one unit, newest first, optionally for one assembly.
     * Across sessions by default: what matters when a board comes back is what
     * has ever been done to it, not what was done today.
     */
    repairs: function (assembly, id) {
      var want = id === undefined ? unitId() : id;
      var out = [];
      db.sessions.forEach(function (s) {
        if (s.unitId !== want) return;
        if (assembly && s.assembly !== assembly) return;
        (s.repairs || []).forEach(function (r) {
          out.push(Object.assign({}, r, { session: s.id, assembly: s.assembly }));
        });
      });
      return out.sort(function (a, b) { return a.at < b.at ? 1 : -1; });
    },

    /** ref -> latest repair status on this board, for filtering and marking. */
    repairIndex: function (assembly) {
      var out = {};
      TestLog.repairs(assembly).slice().reverse().forEach(function (r) {
        out[r.ref] = r.status;
      });
      return out;
    },

    /**
     * ref -> latest verdict, across every session of this unit and board.
     *
     * The board half of that sentence was not true. Refs are only unique
     * within a board -- every one of the thirteen has an R1, a C1, a TP1 --
     * so pooling every session of the unit painted A14's TP4 verdict onto
     * A16's TP4, a different signal with different limits that nobody had
     * measured. A green dot claiming a point is good is exactly the reading
     * someone skips, so this one filters like measuredIndex below it.
     */
    verdicts: function (assembly, session) {
      var out = {};
      var list = session ? [session] : TestLog.sessions();
      list.slice().reverse().forEach(function (s) {
        if (assembly && s.assembly !== assembly) return;
        s.readings.forEach(function (r) {
          // A pin sweep can never be scored, so it must not displace a
          // verdict that was: sweeping the pins of a part just found bad is
          // the natural next diagnostic step, and a grey dot claiming nothing
          // conclusive is exactly the marker a technician skips. It may still
          // say 'unscored' where nothing else has spoken.
          if (r.target === 'pins' && out[r.ref] !== undefined) return;
          out[r.ref] = r.verdict;
        });
      });
      return out;
    },

    /** refs that have any measurement on this board, for the filter chips. */
    measuredIndex: function (assembly) {
      var out = {};
      TestLog.sessions().forEach(function (s) {
        if (assembly && s.assembly !== assembly) return;
        s.readings.forEach(function (r) { out[r.ref] = (out[r.ref] || 0) + 1; });
      });
      return out;
    },

    summary: function (session) {
      var s = session || TestLog.active();
      var out = { total: 0, pass: 0, marginal: 0, fail: 0, unscored: 0,
                  components: 0, testpoints: 0, repairs: 0, replaced: 0 };
      if (!s) return out;
      s.readings.forEach(function (r) {
        out.total++;
        out[r.verdict] = (out[r.verdict] || 0) + 1;
        if (r.target === 'pins') out.pinSets = (out.pinSets || 0) + 1;
        else if (r.target === 'component') out.components++; else out.testpoints++;
      });
      (s.repairs || []).forEach(function (r) {
        out.repairs++;
        if (r.status === 'replaced') out.replaced++;
      });
      return out;
    },

    /**
     * A sweep of pin voltages on one IC or transistor, kept as ONE reading.
     *
     * Fourteen separate readings would say the same thing, but they would say
     * it as fourteen rows that sort apart in the log and lose the one fact
     * that makes a pin sweep worth taking: that these numbers were all true at
     * the same moment, in one state of the instrument. `condition` is that
     * state in the technician's own words -- "idle STBY, A12/A13 absent" --
     * because nothing published says what a pin should read, and without the
     * conditions the numbers cannot be compared to the next sweep.
     *
     * Pins left blank are omitted rather than stored as zero. Not measured and
     * measured as 0 V are different observations, and on a part where you only
     * probed the supply rails, most pins are the former.
     *
     * pinCount travels with the record so that a later sweep of the same part
     * can default to it: the parts list states a pin count for fewer than one
     * IC in five, so the technician's own correction is the better source, and
     * carrying it here means it survives an export and needs no second store.
     */
    recordPins: function (item, opts) {
      var session = TestLog.active();
      if (!session || !item) return null;
      var options = opts || {};
      var pins = (options.pins || []).filter(function (p) {
        return p && p.v != null && p.v !== '' && !isNaN(p.v);
      }).map(function (p) {
        return { pin: Number(p.pin), v: Number(p.v) };
      }).sort(function (a, b) { return a.pin - b.pin; });
      if (!pins.length) return null;
      return push(session, {
        id: uid('r'),
        target: 'pins',
        ref: item.ref,
        label: item.desc || item.ref,
        quantity: 'voltage',
        unit: 'V',
        refPoint: options.refPoint || null,
        at: new Date().toISOString(),
        pinCount: options.pinCount || null,
        condition: options.condition || '',
        pins: pins,
        verdict: 'unscored',
        note: options.note || ''
      });
    },

    /** The most recent pin sweep for one part, or null. */
    lastPins: function (assembly, ref) {
      var found = null;
      TestLog.history(assembly, ref).forEach(function (h) {
        if (h.reading.target === 'pins') found = h.reading;
      });
      return found;
    },

    /** Every reading for one ref on this unit, oldest first. */
    history: function (assembly, ref) {
      var out = [];
      TestLog.sessions().forEach(function (s) {
        if (s.assembly !== assembly) return;
        s.readings.forEach(function (r) {
          if (r.ref === ref) out.push({ session: s, reading: r });
        });
      });
      return out.sort(function (a, b) { return a.reading.at < b.reading.at ? -1 : 1; });
    },

    /** How many sessions were carried forward from the pre-unit log. */
    adoptedCount: function () { return db.adopted || 0; },

    clearAdoptedFlag: function () { db.adopted = 0; persist(); },

    /* ---- export ---- */

    /**
     * One flat row per reading, for a spreadsheet. Repairs do not fit this
     * shape -- they are not measurements -- and get their own file from
     * service.js rather than being bent into these columns.
     */
    exportCSV: function (sessions) {
      var list = sessions || TestLog.sessions();
      var head = ['unit_serial', 'session', 'date', 'assembly',
                  'assembly_serial', 'assembly_rev', 'technician', 'meter',
                  'line_voltage', 'ambient', 'target', 'ref', 'label', 'quantity',
                  'in_circuit', 'reference_point', 'state', 'setup', 'measured', 'unit',
                  'nominal', 'lower_limit', 'upper_limit', 'spec_value', 'spec_tolerance_pct',
                  'deviation', 'percent_off_nominal', 'verdict', 'source', 'note'];
      var rows = [head];
      list.forEach(function (s) {
        var unit = global.Units ? global.Units.get(s.unitId) : null;
        s.readings.forEach(function (r) {
          // A pin sweep is one reading but many measurements, and a
          // spreadsheet wants one number per row. Each pin goes out as
          // "U2-7", which is the same shape the curated probe points already
          // use ("U201-13" in the A18 procedure), so the two sort together and
          // a filter on ref finds both. The condition lands in the state
          // column, which is what it is.
          if (r.target === 'pins') {
            (r.pins || []).forEach(function (p) {
              rows.push([
                (unit && unit.serial) || s.instrumentSerial || '',
                s.id, r.at, s.assembly, s.assemblySerial || '', s.assemblyRev || '',
                s.technician, s.meter, s.lineVoltage, s.ambient,
                'pin', r.ref + '-' + p.pin, r.ref + ' pin ' + p.pin, 'voltage',
                '', r.refPoint || '', r.condition || '', '', p.v, r.unit || 'V',
                '', '', '', '', '', '', '', 'unscored', '', r.note || ''
              ]);
            });
            return;
          }
          var e = r.expected || {};
          var spec = r.spec || {};
          // The ESR bound has no expected{} of its own, but it is the
          // reading's upper limit in every sense a spreadsheet filter cares
          // about, so it rides out in that column.
          var hi = e.hi != null ? round(e.hi)
                 : r.quantity === 'esr' && r.esrLimit != null ? r.esrLimit : '';
          rows.push([
            (unit && unit.serial) || s.instrumentSerial || '',
            s.id, r.at, s.assembly, s.assemblySerial || '', s.assemblyRev || '',
            s.technician, s.meter, s.lineVoltage, s.ambient,
            r.target || 'testpoint', r.ref, r.label, r.quantity || '',
            r.target === 'component' ? (r.inCircuit ? 'in-circuit' : 'out-of-circuit') : '',
            r.refPoint || '', r.stateLabel || '', r.setup || '', r.measured, r.unit,
            e.nominal == null ? '' : e.nominal,
            e.lo == null ? '' : round(e.lo), hi,
            spec.text || '', Parts.toleranceText(spec),
            // In the reading's own unit, not base SI. A capacitance is stored
            // in farads, so 8e-7 F -- a real 0.8 uF error -- came out of a
            // three-decimal rounder as a flat 0 and the column read as though
            // every capacitor were exact.
            r.deviation == null ? ''
              : (r.unit ? round(Parts.toBase(1, r.unit) ? r.deviation / Parts.toBase(1, r.unit) : r.deviation)
                        : round(r.deviation)),
            r.pctOffNominal == null ? '' : round(r.pctOffNominal),
            r.verdict, e.source || '', r.note || ''
          ]);
        });
      });
      // The byte-order mark, because Excel opens a BOM-less UTF-8 csv in the
      // legacy ANSI codepage and mangles every µ and Ω cell -- in the one
      // export whose entire purpose is a spreadsheet. It costs nothing
      // anywhere else: Python, Numbers and LibreOffice all strip it.
      return '\ufeff' +
        rows.map(function (row) { return row.map(csvCell).join(','); }).join('\r\n');
    },

    /** Raw sessions, for service.js to put in the single-file export. */
    dump: function (unitIds) {
      return db.sessions.filter(function (s) {
        return !unitIds || unitIds.indexOf(s.unitId) >= 0;
      });
    },

    /* ---- what is actually plugged into the instrument ----
     *
     * Boards come out during a repair. A 5700A will not start without some of
     * them, a fault is isolated by pulling others, and a suspect board gets
     * swapped for a known-good one to see whether the symptom follows it. The
     * configuration a reading was taken in is therefore part of the reading:
     * "-13.12 V on pin 8" means one thing with every board fitted and another
     * with A12 and A13 out, and this log's own owner has been writing exactly
     * that by hand -- "idle STBY (A12/A13 absent, A15-A18 present)".
     *
     * It is kept as events rather than as a state, because the state is never
     * the interesting part. What was pulled, when, why, and whether the fault
     * went with it is the reasoning of the repair; a checkbox that only
     * remembers its current position throws that away every time it is
     * clicked. The current state is just the newest event per board.
     *
     * It hangs off the unit, not the session, because the instrument keeps its
     * configuration while the technician moves between boards -- and a session
     * is per board.
     */

    /** Every configuration change for one unit, newest first. */
    fitmentLog: function (id) {
      var want = id === undefined ? unitId() : id;
      return db.fitment
        .filter(function (e) { return e.unitId === want; })
        .sort(function (a, b) { return a.at < b.at ? 1 : -1; });
    },

    /**
     * assembly -> its newest event.
     *
     * A board with no event is absent from the map, and that is the point: it
     * means nobody has said, which is different from saying it is fitted.
     */
    fitmentState: function (id) {
      var out = {};
      TestLog.fitmentLog(id).slice().reverse().forEach(function (e) {
        out[e.assembly] = e;
      });
      return out;
    },

    /**
     * Record a change. `state` is 'fitted', 'removed' or 'swapped'.
     *
     * 'swapped' says the slot still holds a board but not the same one -- the
     * known-good substitute. It stays a separate word from 'fitted' because
     * the two answer different questions later: whether the instrument was
     * complete, and whether the board under test was the original.
     */
    setFitment: function (assembly, state, note) {
      var session = TestLog.active();
      var event = {
        id: uid('f'),
        unitId: unitId(),
        assembly: assembly,
        state: state,
        note: (note || '').trim(),
        at: new Date().toISOString(),
        sessionId: session ? session.id : null
      };
      db.fitment.push(event);
      persist();
      global.BoardExplorer.emit('testlog', {});
      return event;
    },

    removeFitment: function (id) {
      forget(id);
      db.fitment = db.fitment.filter(function (e) { return e.id !== id; });
      persist();
      global.BoardExplorer.emit('testlog', {});
    },

    dumpFitment: function (unitIds) {
      return db.fitment.filter(function (e) {
        return !unitIds || unitIds.indexOf(e.unitId) >= 0;
      });
    },

    /** Merge by id, like sessions: re-opening the same file changes nothing. */
    ingestFitment: function (events, remap) {
      var seen = {};
      db.fitment.forEach(function (e) { seen[e.id] = true; });
      var added = 0;
      (events || []).forEach(function (e) {
        if (!e || !e.id || seen[e.id]) return;
        seen[e.id] = true;
        var copy = Object.assign({}, e);
        copy.unitId = (remap && remap[e.unitId]) || e.unitId;
        db.fitment.push(copy);
        added++;
      });
      if (added) persist();
      return added;
    },

    /**
     * Take sessions from an imported file. A session id not seen before
     * arrives whole; one that already exists here is merged item by item
     * rather than skipped, because sessions live for days and a newer export
     * of the same visit carries the same session id with more readings and
     * repairs inside it -- skipping wholesale silently threw those away.
     * Matched by id at both levels, so re-importing the same file twice still
     * changes nothing, and `remap` moves sessions onto whichever local unit
     * the file's unit resolved to.
     *
     * The returned count is of sessions that received anything -- brought in
     * whole or grown -- because sessions are the unit the import summary
     * speaks in.
     */
    ingest: function (sessions, remap) {
      var have = {};
      db.sessions.forEach(function (s) { have[s.id] = s; });
      var touched = 0;
      (sessions || []).forEach(function (s) {
        if (!s || !s.id) return;
        var mine = have[s.id];
        if (mine) {
          if (mergeSessionItems(mine, s)) touched++;
          return;
        }
        var copy = Object.assign({}, s);
        copy.unitId = (remap && remap[s.unitId]) || s.unitId;
        copy.repairs = copy.repairs || [];
        copy.readings = copy.readings || [];
        rescoreEsr(copy.readings);
        db.sessions.push(copy);
        have[copy.id] = copy;
        touched++;
      });
      if (touched) persist();
      return touched;
    }
  };

  function push(session, reading) {
    session.readings.push(reading);
    persist();
    global.BoardExplorer.emit('testlog', { reading: reading });
    return reading;
  }

  function round(v) { return Math.round(v * 1000) / 1000; }

  function csvCell(v) {
    var s = v == null ? '' : String(v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  /**
   * Re-attach sessions whose unit no longer exists.
   *
   * If the unit registry has been rebuilt -- a corrupt store, a cleared key --
   * every session still points at a unit id nothing resolves any more, and a
   * whole bench history sits on disk while every view shows none of it. Each
   * session also names its instrument by serial, which is exactly why that
   * field rides along, so the join can be remade: onto the unit that carries
   * the serial, or onto a new unit made from it. Sessions that never recorded
   * a serial have nothing to join on and are left where they are.
   */
  function rejoinOrphans() {
    var units = global.Units;
    if (!units) return;
    var changed = false;
    db.sessions.forEach(function (s) {
      if (!s.unitId || units.get(s.unitId)) return;
      var serial = (s.instrumentSerial || '').trim();
      if (!serial) return;
      s.unitId = units.adoptImported({ serial: serial }).unit.id;
      changed = true;
    });
    if (changed) persist();
  }

  rejoinOrphans();

  /**
   * Take in whatever another window has written since this one last looked.
   *
   * Called with a storage event, or with nothing at all by a linked view
   * polling on its own clock — the browser does not guarantee the event
   * between file:// windows, and a linked view showing last hour's pass/fail
   * colours beside live circuitry is the failure this whole file exists to
   * avoid. An unchanged store costs one read and returns: no merge, no event,
   * nothing redrawn.
   */
  function absorbExternal(e) {
    if (e && e.key && e.key !== KEY) return;
    var raw = rawStore();
    if (raw === lastRaw) return;
    lastRaw = raw;
    var fresh = null;
    try { fresh = JSON.parse(raw); } catch (err) { return; }
    mergeStore(fresh);
    global.BoardExplorer.emit('testlog', {});
  }

  // The other half of sharing this key between tabs: without hearing about
  // the other tab's writes, this one's cache and screen go stale until its
  // own next write. The event fires only in the tabs that did not make the
  // write, so there is no echo to guard against.
  if (global.addEventListener) {
    global.addEventListener('storage', absorbExternal);
  }

  global.TestLog = TestLog;
})(window);
