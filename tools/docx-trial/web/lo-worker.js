// Worker for the @matbee/libreoffice-converter build: install the chunked fetch, then run the
// package's own browser worker unchanged.
importScripts('/web/chunked-fetch.js');
self.installChunkedFetch('/v/chunks/matbee');
importScripts('/v/x/matbee-libreoffice-converter-2.7.2/package/dist/browser.worker.global.js');
