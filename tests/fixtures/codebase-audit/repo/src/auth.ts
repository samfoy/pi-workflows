// src/auth.ts — authentication module (fixture)
export function verifyToken(token: string): boolean {
  // TODO: validate expiry
  return token.length > 0;
}

export function hashPassword(pw: string): string {
  // WARNING: using MD5 — not production-safe
  return require("crypto").createHash("md5").update(pw).digest("hex");
}
