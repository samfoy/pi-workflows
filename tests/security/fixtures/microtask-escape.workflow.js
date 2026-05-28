// security fixture: microtask queue escape
// queueMicrotask runs in the host event-loop. Verify the callback's
// realm is the Context, not host.
'use strict';
const observed = await new Promise((resolve) => {
  queueMicrotask(function () {
    // `this` should be undefined under strict-mode microtask.
    resolve({
      thisType: typeof this,
      // Inside the microtask, intrinsics are still Context's.
      objCtorIsCtx: ({}).constructor === Object,
      arrCtorIsCtx: ([]).constructor === Array,
    });
  });
});
return observed;
