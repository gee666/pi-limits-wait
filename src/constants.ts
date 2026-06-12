export const CLAUDE_CODE_IDENTITY =
  "You are Claude Code, Anthropic's official CLI for Claude.";

export const PI_REMOVAL_ANCHORS = [
  "pi-coding-agent",
  "@mariozechner/pi-coding-agent",
  "badlogic/pi-mono",
] as const;

export const PI_IDENTITY_SENTENCE_PATTERN =
  /(?:^|\n)\s*You are pi\b[^.!?\n]*(?:[.!?](?=\s|$)|(?=\n|$))/gi;

export const DEFAULT_RATE_LIMIT_WAIT_MS = 30 * 60 * 1_000; // 30 minutes
export const DEFAULT_OVERLOADED_WAIT_MS = 5 * 60 * 1_000; // 5 minutes
export const DEFAULT_NON_RETRYABLE_FREEZE_MS = 60 * 60 * 1_000; // 1 hour
export const SETTINGS_KEY = "oira666_pi-limits-wait";
