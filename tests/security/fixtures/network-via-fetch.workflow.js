// security fixture: network APIs (PRD §8.3.10)
'use strict';
return {
  fetchReachable: typeof fetch !== 'undefined',
  xhrReachable: typeof XMLHttpRequest !== 'undefined',
  wsReachable: typeof WebSocket !== 'undefined',
  // dns, http, https, net, tls — only via require, which is blocked.
  requireReachable: typeof require !== 'undefined',
};
