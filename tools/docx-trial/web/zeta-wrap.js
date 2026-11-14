// Same-origin replacement for zetaHelper's data: URL thread bootstrap (a data: script would need
// script-src data: in the CSP).
import('/v/zeta/zetajs/zetaHelper.js').then((m) => { m.zetaHelperWrapThread(); });
