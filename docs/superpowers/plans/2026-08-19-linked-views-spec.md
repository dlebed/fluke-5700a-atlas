# Linked views — design spec

One **leader** window (the ordinary app) can open any number of **follower**
windows: view-only, chrome-less copies of the stage that track the leader's
navigation — same assembly, same selected part, same search highlights — while
keeping their own zoom, pan, display mode and schematic sheet. The bench use
case is two monitors: board on one, schematic on the other, and the pass/fail
map filling in live on both as readings are recorded in the leader.

## Behaviour

**Leader.** A "⧉ Linked view" button in the stage's bottom control bar opens a
follower via `window.open`, passing the leader's link id and its current
display as URL params. The leader generates one link id per browser tab,
stored in `sessionStorage` so it survives a reload of the leader (followers
re-attach) but is never shared between two leader tabs (two units on two
benches never cross-talk). One exception, which is browser behaviour and not
a choice made here: Chrome and Firefox copy `sessionStorage` into a tab made
with "Duplicate tab", so duplicating the leader gives two leader windows one
id and one key, and a follower then tracks whichever of them moved last —
confusing rather than dangerous, and it recovers on the next move. The leader
publishes navigation state whenever it changes; it reads the key once at
startup to seed its sequence counter and never applies what it finds.

**Follower.** Detected by `?follow=<linkId>` in the URL. It:
- applies the leader's `assembly`, `selected` and `highlighted` — nothing else;
- keeps its own `display` (seeded from the `display` URL param), `sheet`,
  zoom and pan; selection pans at the follower's own zoom only when the
  marker is off screen (the existing `focus()` behaviour);
- when on the Schematic display, turns to the selected part's sheet — for
  free, because selection is applied through the app's own `select()` path;
- hides the side panel and all topbar controls (search, pickers, mode tabs,
  Author), keeping the brand mark plus a static line naming the assembly.
  The bottom strip stays: display tabs, sheet tabs and Fit are per-window
  choices. The floating info card stays — it is the part's data sheet, which
  is what a big screen is for. The status bar stays;
- accepts only view-local keys: `1`–`6`, `Z`, and `Esc` (which hides the
  info card locally, never clearing the leader's selection);
- never records, never edits: mode is pinned to `board` semantics with panels
  hidden, `?author=1` is ignored when `follow` is present, and no recording
  UI exists in the window. (It still shares localStorage with the leader, so
  verdict colouring updates live via the existing cross-tab store listeners.)

## Sync transport

A single localStorage key per link: `fluke5700a.sync.v1.<linkId>`, holding
`{"v":1,"seq":N,"asm":"A18","sel":"C13","hi":["C13","C14"]}` (sel may be
null, hi may be empty). The leader bumps `seq` on every write.

Followers poll the key every 500 ms and compare `seq`; a `window` `storage`
event listener applies changes immediately where the browser fires it
(served origins always; some browsers also on `file://`). Polling is the
correctness mechanism, the event is the accelerator — so the feature works
identically from `file://` with no caveat. A follower opened late (or
reloaded) bootstraps by applying the stored value at startup.

The storage event never fires in the writing window, and the leader's one
read of the key is the startup seed, so there is no echo path by construction.

## Out of scope

- Author Mode in followers (explicitly ignored).
- Syncing hover, zoom, display, sheet, or unit selection.
- Follower→leader communication of any kind.
- Cleaning up sync keys of long-dead links (one tiny key per leader tab;
  the leader reuses its id for its whole tab lifetime). Deferred rather than
  overlooked: one ~120-byte key accumulates per leader tab-session and is
  never pruned — of the order of 12 KB a year of ordinary use, against a 5 MB
  quota shared with the service log.
