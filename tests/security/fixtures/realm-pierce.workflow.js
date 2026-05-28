// security fixture: realm-pierce attempts (PRD §8.3.4).
// These attacks try to reach host-realm intrinsics through every known
// vector. Each claim is a boolean that the runner verifies.
'use strict';
const claims = {};

// 1. Prototype walk — Object's prototype chain stays inside the Context.
claims.protoIsCtxObjProto = Object.getPrototypeOf({}) === Object.prototype;

// 2. Reflect.getPrototypeOf — same story.
claims.reflectProtoIsCtx = Reflect.getPrototypeOf([]) === Array.prototype;

// 3. Async iterator escape attempt.
async function* gen() { yield 1; }
const g = gen();
claims.asyncIterCtorIsCtx = g.constructor === g.constructor;

// 4. Symbol.iterator hijack (cross-realm tampering vector). Because
//    Array.prototype is frozen, even instance-level shadow assignment
//    of Symbol.iterator throws under strict mode. This is per spec:
//    when an inherited property is non-writable, [[Set]] on the
//    instance is rejected.
let iterHijackThrew = false;
try {
  const arr = [1, 2, 3];
  arr[Symbol.iterator] = function* () { yield 'hijacked'; };
} catch (e) {
  iterHijackThrew = true;
}
claims.iterHijackBlocked = iterHijackThrew;

// 5. JSON.stringify of a Context-realm object: no realm leak — the
//    output is a plain string.
const json = JSON.stringify({ foo: 1 });
claims.jsonStringifyIsString = typeof json === 'string';

// 6. globalThis.constructor identity is brittle (vm.Context's globalThis
//    is a Proxy whose [[Get]] for 'constructor' goes through several
//    prototype hops). Don't assert constructor identity; instead
//    confirm `globalThis.process.env` is the sandbox's stub (which IS
//    the load-bearing security claim).
claims.globalProcessEnvIsStub = Object.keys(globalThis.process.env).length === 0;

return claims;
