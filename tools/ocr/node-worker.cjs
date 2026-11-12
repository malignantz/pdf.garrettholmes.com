'use strict';
// tesseract.js worker script for Node (a copy of its own src/worker-script/node/index.js)
// whose core build is chosen by OCR_CORE (relaxedsimd-lstm, simd-lstm, lstm, relaxedsimd,
// simd, plain) instead of by feature detection, so builds can be compared. No fetch: the
// language data is read from a local folder.
const { parentPort, workerData } = require('worker_threads');
const worker = require('tesseract.js/src/worker-script');
const gunzip = require('tesseract.js/src/worker-script/node/gunzip');
const cache = require('tesseract.js/src/worker-script/node/cache');

let core = null;
const getCore = async (_oem, _path, res) => {
	if (!core) {
		const which = (workerData && workerData.core) || process.env.OCR_CORE || 'relaxedsimd-lstm';
		res.progress({ status: 'loading tesseract core', progress: 0 });
		core = require(which === 'plain' ? 'tesseract.js-core/tesseract-core' : `tesseract.js-core/tesseract-core-${which}`);
		res.progress({ status: 'loading tesseract core', progress: 1 });
	}
	return core;
};
const noFetch = () => Promise.reject(new Error('network disabled in the measurement harness'));
parentPort.on('message', (packet) => worker.dispatchHandlers(packet, (obj) => parentPort.postMessage(obj)));
worker.setAdapter({ getCore, gunzip, fetch: noFetch, ...cache });
