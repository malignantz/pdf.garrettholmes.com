# Design — "The Desk"

A quiet work surface. The user's pages are the only loud thing on screen: white
sheets with soft shadows lying on a warm neutral desk. Chrome is thin, ink-colored
and stays out of the way. One red, used for the single primary action on screen
(Export, Place, Done) and for nothing decorative. A relative of garrettholmes.com's
ledger look (laid paper, iron-gall ink, one red) but a tool, not an editorial page.

## Tokens (CSS custom properties on `:root`, dark values under `prefers-color-scheme: dark`)

| Token | Light | Dark | Use |
|---|---|---|---|
| `--desk` | `#ece8de` | `#15130f` | app background |
| `--desk-deep` | `#e0dacb` | `#0e0c09` | wells, drop target |
| `--surface` | `#fbfaf6` | `#211e18` | bars, sheets, dialogs |
| `--sheet` | `#ffffff` | `#ffffff` | PDF pages (always white) |
| `--ink` | `#1d1a14` | `#f1e9d8` | text, icons |
| `--ink-soft` | `#5b5342` | `#bcae92` | secondary text |
| `--line` | `#d7cdb6` | `#3a342a` | hairlines |
| `--accent` | `#a03518` | `#ec7b55` | primary action, selection ring |
| `--accent-ink` | `#ffffff` | `#15130f` | text on accent |
| `--ok` | `#3d5638` | `#9db894` | verified state |
| `--danger` | `#7c2811` | `#ec7b55` | delete confirmation only |

Radius: 6px controls, 10px sheets/dialogs, 2px pages. Shadows: pages get
`0 1px 2px rgb(0 0 0 / .12), 0 4px 14px rgb(0 0 0 / .08)`; nothing else is shadowed
except floating bars. Spacing scale: 4, 8, 12, 16, 24, 32, 48.

## Type

System fonts only (no font downloads): `ui-sans-serif, system-ui, -apple-system,
"Segoe UI", Roboto, sans-serif`. The wordmark and empty-state headline use
`ui-serif, "Iowan Old Style", "Palatino Linotype", Georgia, serif`. Numbers
(page counts, file sizes) use `font-variant-numeric: tabular-nums`. Base 16px;
controls 15px; captions 13px. No all-caps labels except the 11px page-number chip.

## Layout

- **Desktop (≥ 900px):** thin top bar (wordmark left, undo/redo, Export right).
  Page grid fills the rest. A contextual action bar floats bottom-center when
  pages are selected. Thumbnail size slider at bottom-right.
- **Phone:** top bar holds wordmark and Export. Actions live in a bottom bar in
  thumb reach, 48px minimum targets, respecting `env(safe-area-inset-bottom)`.
  Grid is 2 columns (3 in landscape). Long-press starts drag; tap selects once
  selection mode is on; tap otherwise opens the page.
- **Empty state:** the whole desk is the drop target. One headline ("Drop PDFs or
  images here"), one button ("Choose files"), one line of proof ("Files stay on
  this device. This page cannot send them anywhere."), linking to how that is enforced.

## Behavior

- Motion is short and functional: 120–180ms, reorder and delete animate so the
  user sees where pages went. Honor `prefers-reduced-motion`.
- Every control has a visible focus ring (`2px solid var(--accent)`, 2px offset)
  and a keyboard path. Grid supports arrows, Space to select, `R` rotate,
  `Delete`, `Ctrl/Cmd+Z`, `Ctrl/Cmd+A`.
- Icons: inline SVG, 1.5px stroke, 20px. No icon font, no emoji.
- Copy is plain and short. Errors say what happened and what to do.
  Never "Oops". The verified state reads: "Checked: 12 pages, opens cleanly."
