// security fixture: Function constructor escape (PRD §8.3.1)
// Verify that even via Function constructor, the script cannot reach
// the host's globalThis. `process` resolves to the Context's stub.
'use strict';
const F = (() => {}).constructor;
const escape = (new F('return globalThis'))();
const processInEscape = escape.process;
return {
  // Both should point at the SAME Context-globalThis we already see.
  sameGlobal: escape === globalThis,
  // process is the sandbox's stubbed object (env empty).
  envIsEmpty: Object.keys(processInEscape.env).length === 0,
  // Cannot reach require / fetch via the escape.
  requireLeaked: typeof escape.require !== 'undefined',
  fetchLeaked: typeof escape.fetch !== 'undefined',
};
