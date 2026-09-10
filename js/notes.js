/*
 * notes.js — user annotations, stored apart from the dataset.
 *
 * Notes are the one thing here that cannot be regenerated from the manuals:
 * "C13 replaced 2026-08, ESR was 0.9 ohm" is service history for one specific
 * board of one specific calibrator. So they are addressed by
 * {unit, assembly, ref} and survive dropping in a rebuilt data/<asm>.js.
 *
 * The unit in that key is the whole point. Keyed by {assembly, ref} alone -- as
 * they were until this version -- a note written while servicing one 5700A
 * appears on the card while working on another, and both instruments write
 * into the same bucket. Two units on a bench is ordinary, and a shared bucket
 * makes both records wrong rather than one of them missing.
 *
 * They are editable in normal mode -- writing a note during a repair should not
 * require entering an editing mode.
 */
(function (global) {
  'use strict';

  var KEY = 'fluke5700a.notes.v2';
  var LEGACY = 'fluke5700a.notes.v1';

  var store = load();
  var adopted = 0;

  /*
   * The raw text this window last knew the key to hold, so absorbExternal()
   * can tell "another window wrote" from "nothing has moved" without parsing.
   * A linked view calls it twice a second and must not merge and redraw on an
   * unchanged store; persist() keeps it in step so this window's own writes
   * do not come back as news.
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
      // file:// origins can refuse storage entirely; notes still work for the
      // session and can be exported.
      console.warn('notes: storage unavailable, notes are session-only', err);
      return {};
    }
    if (raw != null) {
      try {
        var parsed = JSON.parse(raw);
        if (parsed) return parsed;
      } catch (err) {
        // Corrupt is not absent: the notes are still in the blob, one write
        // away from being gone -- and they are the one thing here that cannot
        // be regenerated. The raw text goes out of persist()'s reach first,
        // so it can be recovered by hand.
        try { global.localStorage.setItem(KEY + '.bak', raw); } catch (e2) {}
        console.warn('notes: stored notes are corrupt; raw copy kept under ' +
                     KEY + '.bak', err);
        return {};
      }
    }
    return adopt();
  }

  /**
   * Bring pre-unit notes forward.
   *
   * The old key holds no instrument, so there is nothing to derive one from:
   * they go to whichever unit is active and the panel says so, because the
   * alternative -- dropping them, or spreading them over every unit -- is
   * worse than one attributed guess the owner can see and correct.
   *
   * The v1 key is left in place.
   */
  function adopt() {
    var old = null;
    try {
      old = JSON.parse(global.localStorage.getItem(LEGACY));
    } catch (err) { return {}; }
    if (!old) return {};
    var unit = global.Units ? global.Units.ensure().id : 'unknown';
    var next = {};
    Object.keys(old).forEach(function (k) {
      if (!old[k] || !old[k].length) return;
      next[unit + '/' + k] = old[k];
      adopted++;
    });
    return next;
  }

  /*
   * Two tabs share this key, and a write is whole-store: a save from a stale
   * cache would erase whatever the other tab had written. So a write re-reads
   * the key first and folds unknown notes in by id. Note ids removed in this
   * tab are remembered and kept out of the merge, because a deletion cannot
   * be told from the other tab's addition by looking at the data.
   */
  var removed = {};

  function mergeStore(fresh) {
    if (!fresh || typeof fresh !== 'object') return;
    Object.keys(fresh).forEach(function (k) {
      var incoming = fresh[k];
      if (!incoming || !incoming.forEach) return;
      var list = store[k] = store[k] || [];
      var seen = {};
      list.forEach(function (n) { if (n && n.id) seen[n.id] = true; });
      var grew = false;
      incoming.forEach(function (n) {
        if (!n || !n.id || seen[n.id] || removed[n.id]) return;
        seen[n.id] = true;
        list.push(n);
        grew = true;
      });
      if (grew) list.sort(function (a, b) { return a.at < b.at ? -1 : 1; });
      if (!list.length) delete store[k];
    });
  }

  /**
   * Write the notes, and say so on screen when it fails. The test log already
   * alarms through the same event; a note that stays on the card for the rest
   * of the session and is gone on reload is precisely the quiet loss this
   * file's header calls unregenerable service history.
   */
  function persist() {
    try {
      var fresh = null;
      try { fresh = JSON.parse(global.localStorage.getItem(KEY)); } catch (err2) { fresh = null; }
      mergeStore(fresh);
      var text = JSON.stringify(store);
      global.localStorage.setItem(KEY, text);
      lastRaw = text;
      Notes.storageFailed = false;
    } catch (err) {
      console.warn('notes: could not persist', err);
      Notes.storageFailed = true;
      global.BoardExplorer.emit('storage', { key: KEY, error: String(err) });
    }
  }

  function unitId() {
    return global.Units ? global.Units.ensure().id : 'unknown';
  }

  function key(assembly, ref, id) {
    return (id || unitId()) + '/' + assembly + '/' + ref;
  }

  var Notes = {
    /** All notes for one item on the unit being worked on, oldest first. */
    get: function (assembly, ref, id) {
      return store[key(assembly, ref, id)] || [];
    },

    has: function (assembly, ref, id) {
      return (store[key(assembly, ref, id)] || []).length > 0;
    },

    add: function (assembly, ref, text, author) {
      if (!text || !text.trim()) return null;
      var note = {
        id: 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        text: text.trim(),
        at: new Date().toISOString(),
        author: author || null
      };
      var k = key(assembly, ref);
      (store[k] = store[k] || []).push(note);
      persist();
      global.BoardExplorer.emit('notes', { assembly: assembly, ref: ref });
      return note;
    },

    update: function (assembly, ref, id, text) {
      var list = store[key(assembly, ref)] || [];
      var note = list.find(function (n) { return n.id === id; });
      if (!note) return false;
      note.text = text.trim();
      note.editedAt = new Date().toISOString();
      persist();
      global.BoardExplorer.emit('notes', { assembly: assembly, ref: ref });
      return true;
    },

    remove: function (assembly, ref, id) {
      var k = key(assembly, ref);
      var list = store[k] || [];
      var next = list.filter(function (n) { return n.id !== id; });
      if (next.length === list.length) return false;
      removed[id] = true;
      if (next.length) store[k] = next; else delete store[k];
      persist();
      global.BoardExplorer.emit('notes', { assembly: assembly, ref: ref });
      return true;
    },

    /** Refs of every annotated item on one board of this unit. */
    annotated: function (assembly) {
      var prefix = unitId() + '/' + assembly + '/';
      return Object.keys(store)
        .filter(function (k) { return k.indexOf(prefix) === 0 && store[k].length; })
        .map(function (k) { return k.slice(prefix.length); });
    },

    /** Free-text search across note bodies on this unit; returns matching refs. */
    search: function (assembly, needle) {
      var prefix = unitId() + '/' + assembly + '/';
      var q = needle.toLowerCase();
      return Object.keys(store).filter(function (k) {
        return k.indexOf(prefix) === 0 && store[k].some(function (n) {
          return n.text.toLowerCase().indexOf(q) >= 0;
        });
      }).map(function (k) { return k.slice(prefix.length); });
    },

    /** How many notes were carried forward from the pre-unit store. */
    adoptedCount: function () { return adopted; },

    clearAdoptedFlag: function () { adopted = 0; },

    /** Raw notes for one or more units, for the single-file export. */
    dump: function (unitIds) {
      if (!unitIds) return store;
      var out = {};
      Object.keys(store).forEach(function (k) {
        if (unitIds.indexOf(k.slice(0, k.indexOf('/'))) >= 0) out[k] = store[k];
      });
      return out;
    },

    /**
     * Merge notes from an imported file. Matched by note id so re-importing
     * the same file twice does not duplicate anything; `remap` moves them onto
     * whichever local unit the file's unit resolved to.
     */
    ingest: function (notes, remap) {
      var added = 0;
      Object.keys(notes || {}).forEach(function (k) {
        var slash = k.indexOf('/');
        var from = k.slice(0, slash);
        var rest = k.slice(slash + 1);
        // A file written before notes were unit-scoped has keys of the form
        // "A18/C13" -- two segments, no unit. Those land on the active unit.
        var target = rest.indexOf('/') < 0
          ? unitId() + '/' + k
          : ((remap && remap[from]) || from) + '/' + rest;
        var existing = store[target] = store[target] || [];
        var seen = {};
        existing.forEach(function (n) { seen[n.id] = true; });
        (notes[k] || []).forEach(function (n) {
          if (!seen[n.id]) { existing.push(n); added++; }
        });
        existing.sort(function (a, b) { return a.at < b.at ? -1 : 1; });
      });
      if (added) persist();
      global.BoardExplorer.emit('notes', {});
      return added;
    },

    /** True after a write has failed, until one succeeds again. */
    storageFailed: false,

    /**
     * Re-read another window's writes on demand. Registered on the storage
     * event below; also called by a linked view, which cannot wait for an
     * event that may never come. See absorbExternal.
     */
    absorbExternal: absorbExternal
  };

  /**
   * Take in whatever another window has written since this one last looked.
   *
   * Called with a storage event, or with nothing at all by a linked view
   * polling on its own clock, because that event is not guaranteed between
   * file:// windows and annotations colour the board in both of them. An
   * unchanged store costs one read and returns.
   */
  function absorbExternal(e) {
    if (e && e.key && e.key !== KEY) return;
    var raw = rawStore();
    if (raw === lastRaw) return;
    lastRaw = raw;
    var fresh = null;
    try { fresh = JSON.parse(raw); } catch (err) { return; }
    mergeStore(fresh);
    global.BoardExplorer.emit('notes', {});
  }

  // Hear about the other tab's writes as they happen, so this tab's cards do
  // not go stale between its own writes. The event fires only in the tabs
  // that did not make the write.
  if (global.addEventListener) {
    global.addEventListener('storage', absorbExternal);
  }

  global.Notes = Notes;
})(window);
