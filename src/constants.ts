export const CLAUDE_CODE_IDENTITY =
  "You are Claude Code, Anthropic's official CLI for Claude.";

export const PI_REMOVAL_ANCHORS = [
  "pi-coding-agent",
  "@earendil-works/pi-coding-agent",
  "badlogic/pi-mono",
] as const;

export const PI_IDENTITY_SENTENCE_PATTERN =
  /(?:^|\n)\s*You are pi\b[^.!?\n]*(?:[.!?](?=\s|$)|(?=\n|$))/gi;

// Strips the host-harness identity clause pi prepends to its system prompt, e.g.
// "You are an expert coding assistant operating inside pi, a coding agent harness."
// The Claude Code identity block already establishes who the assistant is, so
// leaving this clause in tells the model (and Anthropic) it is running inside pi.
export const PI_HARNESS_IDENTITY_PATTERN =
  /\s+operating inside pi,\s*a coding agent harness/gi;

export const CLAUDE_CODE_IDENTITY_PATTERN =
  /(?:^|\n)\s*You are Claude Code, Anthropic's official CLI for Claude\.\s*/gi;

export const DEFAULT_RATE_LIMIT_WAIT_MS = 30 * 60 * 1_000; // 30 minutes
export const DEFAULT_OVERLOADED_WAIT_MS = 5 * 60 * 1_000; // 5 minutes
export const DEFAULT_NETWORK_WAIT_MS = 15 * 1_000; // 15 seconds
export const DEFAULT_NON_RETRYABLE_FREEZE_MS = 10 * 60 * 1_000; // 10 minutes

export const NON_RETRYABLE_MAX_ATTEMPTS = 3;
export const NON_RETRYABLE_RETRY_DELAY_MS = 5 * 1_000; // 5 seconds

export const SETTINGS_FILE_NAME = "limits-wait.json";
export const FALLBACK_MODELS_KEY = "fallback-models";
export const FREEZING_ENV_VAR = "PI_LIMITS_WAIT_FREEZING_ENABLED";
