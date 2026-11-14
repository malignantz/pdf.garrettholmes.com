// Runs inside the ZetaOffice office thread. Adapted from the zetajs "convertpdf" demo (MIT):
// load the document hidden, store it with the writer_pdf_Export filter, tell the page.
import { ZetaHelperThread } from '/v/zeta/zetajs/zetaHelper.js';

const zHT = new ZetaHelperThread();
const zetajs = zHT.zetajs;
const css = zHT.css;
let xModel;
const prop = (Name, Value) => new css.beans.PropertyValue({ Name, Value });

zHT.thrPort.onmessage = (e) => {
	if (e.data.cmd !== 'convert') return;
	const { from, to } = e.data;
	try {
		if (xModel !== undefined && xModel.queryInterface(zetajs.type.interface(css.util.XCloseable))) xModel.close(false);
		xModel = zHT.desktop.loadComponentFromURL('file://' + from, '_blank', 0, [prop('Hidden', true)]);
		xModel.storeToURL('file://' + to, [prop('Overwrite', true), prop('FilterName', 'writer_pdf_Export')]);
		zetajs.mainPort.postMessage({ cmd: 'converted', from, to });
	} catch (err) {
		let msg = String(err);
		try { const exc = zetajs.catchUnoException(err); msg = exc.Message || msg; } catch { /* not a UNO exception */ }
		zetajs.mainPort.postMessage({ cmd: 'failed', from, to, msg });
	}
};
zHT.thrPort.postMessage({ cmd: 'start' });
