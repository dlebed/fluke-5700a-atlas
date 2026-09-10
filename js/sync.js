/*
 * sync.js — linked views: one leader window, any number of followers.
 *
 * The leader is the ordinary app; a follower is the same page opened with
 * ?follow=<id>, showing only the stage and applying the leader's navigation
 * — assembly, selection, highlights — while keeping its own zoom, pan,
 * display and sheet. State crosses windows through one localStorage key per
 * link. Followers poll it, because the storage event is not guaranteed to
 * fire between file:// windows in every browser; where it does fire it only
 * makes the poll's answer arrive sooner. The event never fires in the
 * window that wrote, and the leader reads the key only once at init to seed
 * its sequence counter and never applies what it finds, so there is no echo
 * path to guard against.
 */
(function (global) {
  'use strict';

  var BE = global.BoardExplorer;
  var KEY_PREFIX = 'fluke5700a.sync.v1.';
  var LEADER_ID_KEY = 'fluke5700a.sync.leaderId.v1';
  var POLL_MS = 500;

  var hooks = {};
  var follower = false;
  var linkId = null;
  var seq = 0;
  var lastApplied = 0;

  function param(name) {
    // URLSearchParams exists everywhere this app runs; kept in one place
    // in case a follower URL is ever built by hand with an empty value.
    var p = new global.URLSearchParams(global.location.search);
    var v = p.get(name);
    return v && v.trim() ? v.trim() : null;
  }

  /**
   * One id per leader tab: sessionStorage survives a reload of the same
   * tab, so followers re-attach after the leader refreshes, but is never
   * shared with another tab, so two benches never cross-talk.
   */
  function ensureLeaderId() {
    var id = null;
    try { id = global.sessionStorage.getItem(LEADER_ID_KEY); } catch (err) { /* in-memory */ }
    if (!id) {
      id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      try { global.sessionStorage.setItem(LEADER_ID_KEY, id); } catch (err) { /* in-memory */ }
    }
    return id;
  }

  function payload() {
    seq += 1;
    return {
      v: 1,
      seq: seq,
      asm: BE.state.assembly ? BE.state.assembly.id : null,
      sel: BE.state.selected || null,
      hi: (BE.state.highlighted || []).slice()
    };
  }

  function decode(raw) {
    if (!raw) return null;
    var p;
    try { p = JSON.parse(raw); } catch (err) { return null; }
    if (!p || p.v !== 1 || typeof p.seq !== 'number') return null;
    return p;
  }

  function publish() {
    try {
      global.localStorage.setItem(KEY_PREFIX + linkId, JSON.stringify(payload()));
    } catch (err) { /* a full store already alarms elsewhere; navigation sync just pauses */ }
  }

  // The gate's only job is to stop the 500ms poll from re-applying the
  // payload it already applied — it is not a guard against out-of-order
  // delivery, so equality is the right test, not "greater than". A leader's
  // seq is an in-memory counter, and its own reload restarts it below a
  // follower's high-water mark; ">" would leave that follower permanently
  // deaf, where "!==" recovers on the very next poll.
  function shouldApply(p) { return !!p && p.seq !== lastApplied; }
  function markApplied(p) { lastApplied = p.seq; }

  function apply(p) {
    if (!shouldApply(p)) return;
    var here = BE.state.assembly ? BE.state.assembly.id : null;
    if (p.asm && p.asm !== here) {
      if (hooks.gotoAssembly) hooks.gotoAssembly(p.asm, p.sel || undefined);
    } else if (p.sel && p.sel !== BE.state.selected) {
      if (hooks.select) hooks.select(p.sel, { focus: true });
    } else if (!p.sel && BE.state.selected) {
      // Clearing the selection is not enough: a pinned card stays up on its
      // own, so the follower would keep asserting an expectation for a part
      // the leader has let go of. Both halves live behind the hook, which is
      // where the app keeps the rule.
      if (hooks.clearCard) hooks.clearCard();
    }
    // A follower on the schematic turns to the selected part's sheet through
    // the select route above, which is the app's own path for a part reached
    // by name; nothing further is needed here, and anything that ran on every
    // payload would turn the page on a leader's search keystroke.
    BE.set({ highlighted: p.hi || [] });
    if (hooks.refresh) hooks.refresh();
    if (hooks.draw) hooks.draw();
    // Recorded only once the work is done: a hook that throws leaves the
    // payload unapplied, and the next tick tries it again rather than
    // treating a half-applied word as delivered.
    markApplied(p);
  }

  /**
   * Everything one poll owes a follower: the leader's navigation, and the
   * stores that colour the markers.
   *
   * Recording a reading or writing a note changes no navigation state, so the
   * leader publishes nothing and there is no payload to apply — the follower's
   * only other news of them is the storage event, which is exactly what this
   * module does not trust between file:// windows. Guarded because sync.js is
   * loaded on its own by the node harness.
   */
  function pollTick() {
    readAndApply();
    if (global.TestLog && global.TestLog.absorbExternal) global.TestLog.absorbExternal();
    if (global.Notes && global.Notes.absorbExternal) global.Notes.absorbExternal();
  }

  function readAndApply() {
    apply(decode(safeGet(KEY_PREFIX + linkId)));
  }

  function safeGet(k) {
    try { return global.localStorage.getItem(k); } catch (err) { return null; }
  }

  var Sync = {
    // Computed from the URL, not from init state: App.start asks this while
    // setting the body class, before it has the hooks to hand over.
    isFollower: function () { return !!param('follow'); },

    init: function (h) {
      hooks = h || {};
      follower = Sync.isFollower();
      linkId = follower ? param('follow') : ensureLeaderId();
      if (follower) {
        // The stored value is the leader's latest word; a follower opened
        // late, or reloaded, starts from it rather than from nothing.
        readAndApply();
        global.setInterval(pollTick, POLL_MS);
        global.addEventListener('storage', function (e) {
          if (e && e.key === KEY_PREFIX + linkId) readAndApply();
        });
      } else {
        // seq is in-memory and restarts at 0 on every reload, but the link
        // id survives in sessionStorage, so a reloaded leader keeps writing
        // the same key a follower is already watching. Without this, the
        // first few payloads after a reload would carry seq values the
        // follower has already seen or passed, and the gate below would
        // discard every one of them until the counter caught back up.
        var stored = decode(safeGet(KEY_PREFIX + linkId));
        if (stored) seq = stored.seq;
        // A reloaded leader holds no selection while its followers still show
        // the one from before the reload, and nothing would correct them until
        // it next navigated. One write closes that window.
        publish();
        BE.on('state', function (changed) {
          for (var i = 0; i < changed.length; i++) {
            if (changed[i] === 'assembly' || changed[i] === 'selected' ||
                changed[i] === 'highlighted') { publish(); return; }
          }
        });
      }
    },

    /**
     * Leader only: open one follower window on the given display. Returns the
     * new window, or null where the browser refused to open one — a blocked
     * popup is the one thing about this feature that cannot be relied on, and
     * the caller has to be able to say so.
     */
    openFollower: function (display) {
      var here = BE.state.assembly ? BE.state.assembly.id : '';
      var url = 'index.html?assembly=' + encodeURIComponent(here) +
        '&follow=' + encodeURIComponent(linkId) +
        (display ? '&display=' + encodeURIComponent(display) : '');
      publish();          // so the new window has a snapshot to bootstrap from
      return global.open(url, '_blank');
    },

    /* exposed for the node harness */
    _payload: payload,
    _decode: decode,
    _apply: apply,
    _shouldApply: shouldApply,
    _markApplied: markApplied,
    // A follower's link id is the URL param itself, so this answers before
    // init the same way isFollower does; a leader's id exists only once
    // init has minted or recovered it from sessionStorage.
    _linkId: function () {
      if (linkId) return linkId;
      return Sync.isFollower() ? param('follow') : null;
    }
  };

  global.Sync = Sync;
})(window);
