// security fixture: timer-based escape (PRD §8.3.5)
// Verify that `this`-binding inside a setTimeout callback does NOT
// leak the host's globalThis (or the Timeout object).
'use strict';
const observed = await new Promise((resolve) => {
  function cb() {
    // `this` here should be undefined under strict mode.
    resolve({
      thisType: typeof this,
      thisIsCtxGlobal: this === globalThis,
      // Use a host-realm object detection: a leak would put the host's
      // Timeout class in `this.constructor.name`.
      thisCtorName: this == null ? null : (this.constructor && this.constructor.name) || null,
    });
  }
  setTimeout(cb, 5);
});
return observed;
