// src/api.ts — HTTP API layer (fixture)
import { verifyToken } from "./auth.js";

export async function handleRequest(req: { token: string; body: unknown }) {
  if (!verifyToken(req.token)) throw new Error("Unauthorized");
  return { ok: true, data: req.body };
}
