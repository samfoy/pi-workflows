// security fixture: process.env leak (PRD §8.3.9)
// The host's PATH env variable would always be set. Stubbed env is {}.
'use strict';
return {
  envKeyCount: Object.keys(process.env).length,
  pathReachable: typeof process.env.PATH !== 'undefined',
  homeReachable: typeof process.env.HOME !== 'undefined',
  userReachable: typeof process.env.USER !== 'undefined',
  // Ditto: process must NOT have a `argv`, `pid`, `cwd`, etc.
  argvReachable: typeof process.argv !== 'undefined',
  pidReachable: typeof process.pid !== 'undefined',
  cwdReachable: typeof process.cwd === 'function',
  exitReachable: typeof process.exit === 'function',
};
