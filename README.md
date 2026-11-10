Projects Key: `project:pdf-garrettholmes`

# pdf.garrettholmes.com

A free PDF workspace that runs entirely in your browser. Drop in PDFs and
images, arrange every page in one grid, rotate, delete, sign and type on pages,
then export once. Files never leave your device, and every export is checked
before you can download it.

- **One workspace** instead of one tool per page.
- **No uploads.** A Content-Security-Policy blocks the page from contacting any other server.
- **Verified output.** Each export passes a structure check, a page comparison and a re-open test.

## Develop

```sh
npm install
npm run dev        # local dev server
npm run check      # types
npm test           # unit tests (engine, store, renderer)
npm run test:e2e   # Playwright, desktop and phone
npm run build      # static site in build/
npx wrangler deploy  # after a build: Cloudflare Worker, static assets only
```

## How it works

See [the plan](docs/plans/plan-2026-11-09.md) for architecture and scope, and
[DESIGN.md](DESIGN.md) for the interface. Engines: [qpdf](https://github.com/qpdf/qpdf)
(page operations, encryption, checking), [PDF.js](https://github.com/mozilla/pdf.js)
(rendering), [pdf-lib](https://github.com/cantoo-scribe/pdf-lib) (stamps).

## License

AGPL-3.0-or-later. See `LICENSE` and `THIRD-PARTY.md`.
