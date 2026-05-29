// src/data.ts — data layer (fixture)
const cache: Record<string, unknown> = {};

export function get(key: string): unknown {
  return cache[key]; // no TTL, unbounded growth
}

export function set(key: string, value: unknown): void {
  cache[key] = value;
}
