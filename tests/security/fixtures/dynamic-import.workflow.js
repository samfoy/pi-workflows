// security fixture: dynamic import escape attempt
'use strict';
let importThrew = false;
let importErr = null;
try {
  await import('node:fs');
} catch (e) {
  importThrew = true;
  importErr = String(e && e.message || e);
}
let importHttpsThrew = false;
try {
  await import('node:https');
} catch (e) {
  importHttpsThrew = true;
}
let importLocalThrew = false;
try {
  await import('/etc/passwd');
} catch (e) {
  importLocalThrew = true;
}
return {
  fsImportThrew: importThrew,
  fsErrorMessage: importErr,
  httpsImportThrew: importHttpsThrew,
  localImportThrew: importLocalThrew,
};
