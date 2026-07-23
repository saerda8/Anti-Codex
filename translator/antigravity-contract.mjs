export const MAX_CHAT_BODY_BYTES = 128 * 1024 * 1024;
export const MAX_NATIVE_MCP_BODY_BYTES = 8 * 1024 * 1024;
export const DEFAULT_TOOL_CONTINUATION_TIMEOUT_MS = 15 * 60 * 1000;

export function boundedPositiveInteger(value, fallback, maximum) {
  const parsed = Number(value);
  const selected = Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
  return Math.min(selected, maximum);
}
