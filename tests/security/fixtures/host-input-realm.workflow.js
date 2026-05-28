// security fixture: redteam #10 mitigation —
// JSON.stringify of host-realm objects passed in via opts must NOT
// inadvertently serialize from the host realm. The runner passes a
// host-realm object as `input`; the fixture verifies the value's
// constructor identity.
'use strict';
// `input` was passed in. In the slice-2 design, host-side `runScript`
// does `JSON.parse(JSON.stringify(input))` before binding so the
// Context only ever sees a fresh Context-realm object. Verify.
return {
  inputType: typeof input,
  inputCtorIsCtxObject: input && input.constructor === Object,
  inputJsonRoundTrip: JSON.stringify(input),
  inputProtoIsCtxObjProto: input && Object.getPrototypeOf(input) === Object.prototype,
};
