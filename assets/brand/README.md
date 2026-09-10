# Fluke 5700A Atlas — mark

A white square with a Fluke-yellow check: the instrument's own "all good"
annunciator, squared to a pixel grid.

## Geometry

32-unit box. Border inset 2, stroke 2. Check runs (8.5,16.5) -> (13.5,22) ->
(24,9.5), stroke 3.4, square caps. Colours are the app's own tokens:
`--silk` #e9e3d2, `--fluke` #f2b035, `--pcb-deep` #0e141c.

Below 24px thicken both strokes and pull the check out toward the edges so it
does not fill in:

| size | border | check | check path |
|---|---|---|---|
| 32 | 2 | 3.4 | `M8.5 16.5 13.5 22 24 9.5` |
| 24 | 2.3 | 3.7 | `M8.4 16.5 13.5 22 24 9.4` |
| 20 | 2.6 | 4.0 | `M8.2 16.5 13.5 22.2 24.2 9.2` |
| 16 | 3.0 | 4.4 | `M8 16.5 13.5 22.5 24.5 9` |

## Files

- `mark.svg` — outlined, for the header
- `mark-solid.svg` — solid white square, dark check
- `mark-mono.svg` — single colour via `currentColor`, for print
- `favicon.svg` — full-bleed solid, for the tab

## Header

Inline the mark inside the existing `.brand` block so it inherits the divider
rule and needs no new CSS beyond one line:

```html
<div class="brand">
  <svg class="brand-mark" viewBox="0 0 32 32" fill="none" aria-hidden="true">
    <rect x="2" y="2" width="28" height="28" stroke="#e9e3d2" stroke-width="2.3"/>
    <path d="M8.4 16.5 13.5 22 24 9.4" stroke="#f2b035" stroke-width="3.7" stroke-linecap="square"/>
  </svg>
  <span class="brand-model">5700A</span>
  <span class="brand-role">Atlas</span>
</div>
```

```css
.brand-mark { width: 24px; height: 24px; flex: 0 0 auto; }
```

The mark is inlined rather than an `<img>` so it stays sharp and can pick up
`--silk` / `--fluke` if those ever change.

## Tab icon

```html
<link rel="icon" href="logo/favicon.svg" type="image/svg+xml">
```

## Zero-file option

Nothing here needs to be a file. The mark is 2 SVG elements, so it can live
entirely inside `index.html` — inline the `<svg>` in the header (above) and put
the favicon in as a data URI:

```html
<link rel="icon" type="image/svg+xml"
      href="data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2232%22%20height%3D%2232%22%20viewBox%3D%220%200%2032%2032%22%20fill%3D%22none%22%20role%3D%22img%22%20aria-label%3D%22Fluke%205700A%20Atlas%22%3E%0A%20%20%3Crect%20width%3D%2232%22%20height%3D%2232%22%20fill%3D%22%23e9e3d2%22%3E%3C%2Frect%3E%0A%20%20%3Cpath%20d%3D%22M8%2016.5%2013.5%2022.5%2024.5%209%22%20stroke%3D%22%230e141c%22%20stroke-width%3D%224.4%22%20stroke-linecap%3D%22square%22%3E%3C%2Fpath%3E%0A%3C%2Fsvg%3E">
```

Inlining is the better default here: one fewer request, the mark stays sharp at
any zoom, and it can read `--silk` / `--fluke` straight from the stylesheet:

```html
<svg class="brand-mark" viewBox="0 0 32 32" fill="none" aria-hidden="true">
  <rect x="2" y="2" width="28" height="28" stroke="currentColor" stroke-width="2.3"/>
  <path d="M8.4 16.5 13.5 22 24 9.4" stroke="var(--fluke)" stroke-width="3.7" stroke-linecap="square"/>
</svg>
```

```css
.brand-mark { width: 24px; height: 24px; flex: 0 0 auto; color: var(--silk); }
```

The `logo/*.svg` files are there for the places that need a real file — README
images, exported test-log HTML, print.

## Clear space and don'ts

Keep one border-width (about 1/16 of the box) of clear space on all sides. Do
not round the corners, recolour the check anything but yellow or the dark navy,
or place the outlined version on a light background — use `mark-mono.svg` there.
