/*
 * units.js — which physical instrument the bench work belongs to.
 *
 * A 5700A is a serial number, and everything recorded here is recorded about
 * one: readings, repairs and notes all belong to a unit before they belong to
 * an assembly. Without that, "C13 replaced, ESR was 0.9 ohm" written while
 * servicing one calibrator appears on the card while working on another, and
 * both write into the same bucket. That is not a display bug, it is a wrong
 * service record, and it is the reason this file exists.
 *
 * The key is a generated id, not the serial itself, so that a serial typed
 * wrongly can be corrected by editing a field rather than by re-keying every
 * record that hangs off it. The serial is what identifies the unit to a human
 * and is what every export and every report carries; the id is only plumbing.
 */
(function (global) {
  'use strict';

  var KEY = 'fluke5700a.units.v1';
  var LEGACY_LOG = 'fluke5700a.testlog.v1';

  var db = load();

  function load() {
    var raw = null;
    try {
      raw = global.localStorage.getItem(KEY);
    } catch (err) {
      console.warn('units: storage unavailable, this session is in-memory only', err);
      return adopt();
    }
    var parsed = null;
    if (raw != null) {
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        // A blob that does not parse is not absent storage: it still holds
        // the only mapping from unit ids to serials, which is what every
        // session and note in the other stores hangs off. Put the raw text
        // out of persist()'s reach before anything can overwrite it, so the
        // mapping can be recovered by hand.
        try { global.localStorage.setItem(KEY + '.bak', raw); } catch (e2) {}
        console.warn('units: stored registry is corrupt; raw copy kept under ' +
                     KEY + '.bak', err);
      }
    }
    if (parsed && parsed.units) return parsed;
    return adopt();
  }

  /**
   * First run under unit-scoped storage: take the serials out of whatever the
   * old flat test log holds and make units of them, so an existing bench
   * history arrives already sorted by instrument instead of in one heap.
   *
   * The old keys are read and left alone. Nothing is deleted here, on the
   * principle that a migration which cannot be undone had better be right the
   * first time, and this one is guessing.
   */
  function adopt() {
    var fresh = { version: 1, units: [], activeId: null, adopted: false };
    var legacy = null;
    try {
      legacy = JSON.parse(global.localStorage.getItem(LEGACY_LOG));
    } catch (err) { /* nothing to adopt */ }
    var serials = [];
    ((legacy && legacy.sessions) || []).forEach(function (s) {
      var serial = (s.instrumentSerial || '').trim();
      if (serial && serials.indexOf(serial) < 0) serials.push(serial);
    });
    serials.forEach(function (serial) {
      fresh.units.push(make({ serial: serial }));
    });
    if (fresh.units.length) {
      fresh.activeId = fresh.units[0].id;
      fresh.adopted = true;
    }
    return fresh;
  }

  /*
   * Two tabs share this key, and a write is whole-store: a save from a stale
   * cache would erase whatever the other tab had added. So a write re-reads
   * the key first and folds unknown units in by id. Ids removed in this tab
   * are remembered and kept out of the merge, because a deletion cannot be
   * told from the other tab's addition by looking at the data.
   */
  var removed = {};

  function mergeStore(fresh) {
    if (!fresh || !fresh.units || !fresh.units.forEach) return;
    var have = {};
    db.units.forEach(function (u) { have[u.id] = true; });
    fresh.units.forEach(function (u) {
      if (u && u.id && !have[u.id] && !removed[u.id]) db.units.push(u);
    });
  }

  /**
   * Write the registry, and say so on screen when it fails: a serial typed in
   * and never saved silently reverts every reading to the wrong instrument's
   * identity on the next load, which is exactly the wrong service record this
   * file exists to prevent. The test log already alarms this way, and half a
   * bench losing writes quietly while the other half shouts is worse than
   * either behaviour alone.
   */
  function persist() {
    try {
      var fresh = null;
      try { fresh = JSON.parse(global.localStorage.getItem(KEY)); } catch (err2) { fresh = null; }
      mergeStore(fresh);
      global.localStorage.setItem(KEY, JSON.stringify(db));
      Units.storageFailed = false;
    } catch (err) {
      console.warn('units: could not persist', err);
      Units.storageFailed = true;
      global.BoardExplorer.emit('storage', { key: KEY, error: String(err) });
    }
  }

  function make(meta) {
    return {
      id: 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      serial: (meta.serial || '').trim(),
      model: meta.model || '5700A',
      name: meta.name || '',
      note: meta.note || '',
      createdAt: new Date().toISOString()
    };
  }

  var Units = {
    all: function () { return db.units.slice(); },

    get: function (id) {
      return db.units.find(function (u) { return u.id === id; }) || null;
    },

    /** The unit being worked on. Never null once ensure() has run. */
    active: function () {
      return Units.get(db.activeId);
    },

    activeId: function () { return db.activeId; },

    /**
     * There is always a unit, because a reading with no instrument attached is
     * a reading that cannot be filed. One calibrator on the bench should not
     * mean managing a registry, so the first one is made silently and asks for
     * its serial later.
     */
    ensure: function () {
      if (Units.active()) return Units.active();
      if (db.units.length) {
        db.activeId = db.units[0].id;
      } else {
        var unit = make({});
        db.units.push(unit);
        db.activeId = unit.id;
      }
      persist();
      return Units.active();
    },

    setActive: function (id) {
      if (!Units.get(id)) return null;
      db.activeId = id;
      persist();
      global.BoardExplorer.emit('unit', { active: id });
      return Units.active();
    },

    create: function (meta) {
      var unit = make(meta || {});
      db.units.push(unit);
      db.activeId = unit.id;
      persist();
      global.BoardExplorer.emit('unit', { active: unit.id });
      return unit;
    },

    update: function (id, patch) {
      var unit = Units.get(id);
      if (!unit) return null;
      Object.keys(patch).forEach(function (k) {
        unit[k] = typeof patch[k] === 'string' ? patch[k].trim() : patch[k];
      });
      persist();
      global.BoardExplorer.emit('unit', { active: db.activeId });
      return unit;
    },

    /**
     * Drop a unit from the registry. Nothing else moves: records filed under
     * the removed id stay on disk in their own stores but become unreachable,
     * since every view and per-unit export filters by a unit id that no
     * longer resolves. Sessions can find their way back -- they carry the
     * instrument serial and are re-joined on it when the log loads -- but
     * notes and procedure ticks carry only the id and stay orphaned. The one
     * caller is the importer's pruning of the empty placeholder unit, which
     * checks all of that is moot before calling.
     */
    remove: function (id) {
      removed[id] = true;
      db.units = db.units.filter(function (u) { return u.id !== id; });
      if (db.activeId === id) db.activeId = db.units.length ? db.units[0].id : null;
      persist();
      global.BoardExplorer.emit('unit', { active: db.activeId });
    },

    /** Add a unit from an imported file, matching on serial so one instrument
     *  does not split in two because its log came back from another bench. */
    adoptImported: function (unit) {
      var serial = (unit.serial == null ? '' : String(unit.serial)).trim();
      // Guarded, because units already in the store may themselves have come
      // from a file: units this app makes always carry at least serial '',
      // but a hand-edited or truncated file can plant one with no serial
      // field at all, and an unguarded .trim() here then crashed every later
      // import before it ingested anything.
      var existing = serial && db.units.find(function (u) {
        return String(u.serial || '').trim().toLowerCase() === serial.toLowerCase();
      });
      if (existing) return { unit: existing, added: false, mappedFrom: unit.id };
      var copy = Object.assign({}, unit);
      // Normalised on the way in for the same reason: a malformed file should
      // degrade one import, not poison the store for every one after it.
      copy.serial = serial;
      copy.model = copy.model == null ? '5700A' : String(copy.model);
      copy.name = copy.name == null ? '' : String(copy.name);
      copy.note = copy.note == null ? '' : String(copy.note);
      if (!copy.id || Units.get(copy.id)) copy.id = make({}).id;
      db.units.push(copy);
      if (!db.activeId) db.activeId = copy.id;
      persist();
      return { unit: copy, added: true, mappedFrom: unit.id };
    },

    /** How a unit should read in a list, a header or a report. */
    label: function (unit) {
      if (!unit) return 'no unit';
      var serial = (unit.serial || '').trim();
      var name = (unit.name || '').trim();
      if (serial && name) return name + ' (' + serial + ')';
      if (serial) return (unit.model || '5700A') + ' ' + serial;
      if (name) return name;
      return 'unit with no serial yet';
    },

    /** True while the active unit still has no serial on it. */
    needsSerial: function () {
      var unit = Units.active();
      return !unit || !(unit.serial || '').trim();
    },

    /** Whether units were invented from an older flat log on this load. */
    wasAdopted: function () { return !!db.adopted; },

    clearAdoptedFlag: function () { db.adopted = false; persist(); },

    exportUnits: function (ids) {
      return db.units.filter(function (u) { return !ids || ids.indexOf(u.id) >= 0; });
    },

    /** True after a write has failed, until one succeeds again. */
    storageFailed: false
  };

  // Hear about the other tab's writes as they happen, so this tab's cache and
  // unit picker do not go stale between its own writes. The event fires only
  // in the tabs that did not make the write.
  if (global.addEventListener) {
    global.addEventListener('storage', function (e) {
      if (e && e.key && e.key !== KEY) return;
      var fresh = null;
      try { fresh = JSON.parse(global.localStorage.getItem(KEY)); } catch (err) { return; }
      mergeStore(fresh);
      global.BoardExplorer.emit('unit', { active: db.activeId });
    });
  }

  global.Units = Units;
})(window);
