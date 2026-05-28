/**
 * Helper: build a real-pi-shaped `agent_end` event sequence. Captured
 * from a live `pi -p 'say hi' --mode json` run on 2026-05-28
 * (pi 0.74.0). Tests use this to assert the dispatcher's stream parse
 * recognizes the canonical event vocabulary, NOT the slice-5 builder's
 * invented `result` type.
 */

export const REAL_PI_EVENT_TYPES = [
  "session",
  "agent_start",
  "turn_start",
  "message_start",
  "message_end",
  "message_start",
  "message_update",
  "message_end",
  "turn_end",
  "session_info_changed",
  "agent_end",
] as const;

export interface RealStreamOpts {
  text?: string;
  toolCalls?: number;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    totalTokens?: number;
  };
}

/**
 * Produce a byte string that resembles a real `pi --mode json` stream
 * with the assistant's final reply being `text`. Each event is an
 * NDJSON line. Optionally interleaves N `tool_call` events between the
 * turn_start and the user message_end.
 */
export function realPiStream(opts: RealStreamOpts = {}): string {
  const text = opts.text ?? "ok";
  const usage = {
    input: opts.usage?.input ?? 6,
    output: opts.usage?.output ?? 1,
    cacheRead: opts.usage?.cacheRead ?? 0,
    cacheWrite: opts.usage?.cacheWrite ?? 0,
    totalTokens: opts.usage?.totalTokens ?? 7,
  };
  const lines: object[] = [
    { type: "session", version: 3, id: "fake-session", cwd: "/tmp", timestamp: "2026-05-28T22:00:00Z" },
    { type: "agent_start" },
    { type: "turn_start" },
    { type: "message_start", message: { role: "user", content: [{ type: "text", text: "say hi" }] } },
    { type: "message_end", message: { role: "user", content: [{ type: "text", text: "say hi" }] } },
    { type: "message_start", message: { role: "assistant", content: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 } } },
  ];
  for (let i = 0; i < (opts.toolCalls ?? 0); i++) {
    lines.push({ type: "tool_call", name: "fake_tool", arguments: { i } });
    lines.push({ type: "tool_result", id: `t${i}`, ok: true });
  }
  lines.push(
    { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } },
    { type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], usage } },
    { type: "turn_end", message: { role: "assistant", content: [{ type: "text", text }], usage }, toolResults: [] },
    { type: "session_info_changed", name: text },
    {
      type: "agent_end",
      messages: [
        { role: "user", content: [{ type: "text", text: "say hi" }] },
        { role: "assistant", content: [{ type: "text", text }], usage },
      ],
    },
  );
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}
