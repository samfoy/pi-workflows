// security fixture: prototype pollution
// PRD §8.3.2 — `Object.freeze(Object.prototype)` defends.
// The fixture asserts that:
//   1. The assignment THROWS (under strict-mode wrapper).
//   2. After the throw is caught, no host-prototype mutation survived.
'use strict';
let threw = false;
try {
  Object.prototype.poisoned = 'pwn';
} catch (e) {
  threw = true;
}
return {
  threw,
  // Inside the sandbox, observe whether the property landed.
  observedFromCtx: ({}).poisoned,
};
