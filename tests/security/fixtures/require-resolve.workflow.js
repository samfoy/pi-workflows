// security fixture: require / module resolution
'use strict';
return {
  requireReachable: typeof require !== 'undefined',
  moduleReachable: typeof module !== 'undefined',
  // Even via Function constructor, require can't be reached.
  reqViaEval: (() => {
    try { return typeof eval('require'); } catch (e) { return 'threw'; }
  })(),
  reqViaFunction: (() => {
    try { return typeof (Function('return require'))(); } catch (e) { return 'threw'; }
  })(),
};
