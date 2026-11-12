// @ts-nocheck -- plain Node worker script (CommonJS, untyped tesseract.js internals)
'use strict';
// tesseract.js worker script for Node (tests and measurements): tesseract.js's own
// worker-script with the core build named by the parent (workerData.core), loaded from
// node_modules. No fetch: the language data is written into the worker's file system by
// the client (src/lib/engine/ocr/tess.ts), as in the browser.
const { parentPort, workerData } = require('node:worker_threads');
const worker = require('tesseract.js/src/worker-script');
const gunzip = require('tesseract.js/src/worker-script/node/gunzip');
const cache = require('tesseract.js/src/worker-script/node/cache');

let core = null;
const getCore = async () => {
	if (!core) core = require(`tesseract.js-core/tesseract-core-${workerData.core}`);
	return core;
};
const noFetch = () => Promise.reject(new Error('network disabled'));
parentPort.on('message', (packet) => worker.dispatchHandlers(packet, (obj) => parentPort.postMessage(obj)));
worker.setAdapter({ getCore, gunzip, fetch: noFetch, ...cache });
