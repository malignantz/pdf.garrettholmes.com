# pdf.garrettholmes.com — rules for agents

Local-first PDF workspace. Read `docs/plans/plan-2026-11-09.md` (vision,
architecture, ownership table) and `DESIGN.md` before changing anything.

## Hard rules

- **No network.** Nothing in the app may call a third-party origin: no CDN, no
  analytics script, no remote fonts, no telemetry. All engines are bundled.
- **Never ship an unverified export.** `Engine.exportPlan` verifies or throws.
- **Avoid, don't fail.** If a feature cannot be made near-100% reliable, leave it
  out and note it in the plan's backlog. Do not add lossy or heuristic tools.
- **Licenses.** The repo is AGPL-3.0. Dependencies must be compatible; record
  each bundled engine in `THIRD-PARTY.md`.
- Contracts are in `src/lib/core/types.ts`. Do not change them silently.

## Conventions

- Svelte 5 runes, TypeScript strict, tabs. No UI framework, no CSS framework;
  use the tokens in `src/app.css`.
- Heavy code (qpdf, pdf-lib, PDF.js) is loaded with dynamic `import()` on first
  use, never from the entry bundle.
- Tests: `npm run check`, `npm test` (Vitest), `npm run test:e2e` (Playwright).
  Add a corpus file and a test for every PDF bug fixed.
- On the Debian box, Playwright uses system Chrome: `/opt/google/chrome/chrome`.

## Git

- Work on a branch (or a worktree; never `git checkout` in a tree another
  session may share). Commit per completed task. Never force-push.
- Pushing to `main` is allowed for this repo once `npm run check && npm test` pass.
- No to-do files in the repo; the engineering backlog is a section of the plan.
