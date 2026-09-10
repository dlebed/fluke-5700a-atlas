/*
 * registry.js — assembly registry, shared state and a minimal event bus.
 *
 * Data files call BoardExplorer.register() at load time; nothing is fetched, so
 * the page works when opened straight from the filesystem.
 */
(function (global) {
  'use strict';

  var assemblies = {};
  var listeners = {};

  var state = {
    assembly: null,      // the active dataset
    mode: 'board',       // board | testpoints | log | procedure
    display: 'drawing',  // drawing | photo | overlay | swipe | schematic | split
    sheet: 'sh1',        // active schematic sheet
    overlayOpacity: 0.55,
    swipe: 0.5,
    selected: null,      // ref of the selected item
    hovered: null,
    highlighted: [],     // refs highlighted by a search or a procedure step
    author: false
  };

  var BoardExplorer = {
    state: state,

    register: function (dataset) {
      // Index once, so lookups elsewhere are plain object access.
      dataset.byRef = {};
      (dataset.components || []).forEach(function (c) {
        c.isTestPoint = false;
        dataset.byRef[c.ref] = c;
      });
      (dataset.testpoints || []).forEach(function (t) {
        t.isTestPoint = true;
        dataset.byRef[t.ref] = t;
      });
      dataset.probeByRef = {};
      (dataset.probePoints || []).forEach(function (p) {
        dataset.probeByRef[p.id] = p;
      });
      assemblies[dataset.id] = dataset;
      BoardExplorer.emit('registered', dataset);
      return dataset;
    },

    /**
     * Assemblies in board order: A7, A8, A9, A10 ... A19.
     *
     * A plain string sort puts A10 before A7, because it compares '1' against
     * '7' and stops. The instrument numbers its boards, so the picker follows
     * the numbers -- someone looking for A9 looks between A8 and A10, not at
     * the bottom of the list. Sorting on the number and keeping the prefix as
     * the tie-break leaves room for a designator like A11A1 later.
     */
    list: function () {
      return Object.keys(assemblies).sort(function (a, b) {
        var na = parseInt(a.replace(/^[A-Za-z]+/, ''), 10);
        var nb = parseInt(b.replace(/^[A-Za-z]+/, ''), 10);
        if (na !== nb) return na - nb;
        return a < b ? -1 : a > b ? 1 : 0;
      }).map(function (id) { return assemblies[id]; });
    },

    get: function (id) { return assemblies[id]; },

    /** All items that can be located and hovered: components and test points. */
    items: function (dataset) {
      var d = dataset || state.assembly;
      if (!d) return [];
      return (d.components || []).concat(d.testpoints || []);
    },

    lookup: function (ref) {
      var d = state.assembly;
      return d ? d.byRef[ref] : null;
    },

    set: function (patch) {
      var changed = [];
      Object.keys(patch).forEach(function (k) {
        if (state[k] !== patch[k]) {
          state[k] = patch[k];
          changed.push(k);
        }
      });
      if (changed.length) BoardExplorer.emit('state', changed);
      return changed;
    },

    on: function (event, fn) {
      (listeners[event] = listeners[event] || []).push(fn);
      return fn;
    },

    emit: function (event, payload) {
      (listeners[event] || []).forEach(function (fn) {
        try {
          fn(payload);
        } catch (err) {
          console.error('[' + event + ']', err);
        }
      });
    }
  };

  global.BoardExplorer = BoardExplorer;
})(window);
