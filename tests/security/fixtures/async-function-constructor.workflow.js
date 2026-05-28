// security fixture: AsyncFunction-via-Function (PRD §8.3.3)
'use strict';
const AF = (async () => {}).constructor;
const f = new AF('return globalThis');
const escapedAsync = f();
// The async function returns a Promise resolving to globalThis.
const result = await escapedAsync;
return {
  // The escape resolves to the SAME Context globalThis we already see.
  sameAsCtxGlobal: result === globalThis,
  // process is the sandbox's stubbed object — NOT the host's process.
  envEmpty: Object.keys(result.process.env).length === 0,
  // No host capabilities reachable through the escape.
  requireLeaked: typeof result.require !== 'undefined',
  fetchLeaked: typeof result.fetch !== 'undefined',
  // result.constructor identity is brittle in vm.Context (the global
  // proxy's `constructor` lookup goes through several prototype hops).
  // The load-bearing assertion is `same as Ctx globalThis` + no host
  // capability reachable.
};
