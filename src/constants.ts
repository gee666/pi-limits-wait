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

// Unknown provider errors are retried separately from rate-limit, overload,
// authentication, and network failures.
export const DEFAULT_UNKNOWN_ERROR_MAX_RETRIES = 999_999;
export const DEFAULT_UNKNOWN_ERROR_RETRY_INTERVAL_MS = 5 * 1_000; // 5 seconds

// Non-interactive hosts (RPC/JSON) cannot render the TUI countdown, so retry
// progress is published as periodic liveliness notifications instead.
export const LIVELINESS_STATUS_KEY = "oira666.pi-limits-wait";
export const DEFAULT_LIVELINESS_INTERVAL_MS = 15 * 1_000; // 15 seconds

/** Machine-readable sibling of LIVELINESS_STATUS_KEY. Compact JSON, never prose. */
export const LIVELINESS_JSON_STATUS_KEY = "oira666.pi-limits-wait.json";
/** Payload schema version for LIVELINESS_JSON_STATUS_KEY. Bump only on a breaking change. */
export const LIVELINESS_JSON_VERSION = 1;
export const EXTENSION_VERSION = "0.5.7";

export const SETTINGS_FILE_NAME = "limits-wait.json";
export const FALLBACK_MODELS_KEY = "fallback-models";
export const DISABLE_ALL_WAITING_ENV_VAR = "PI_LIMITS_WAIT_DISABLE_ALL_WAITING";
export const FREEZING_ENV_VAR = "PI_LIMITS_WAIT_FREEZING_ENABLED";
export const DEFAULT_WAITING_ENV_VAR = "PI_LIMITS_WAIT_DEFAULT_WAITING";
export const MAX_RETRY_ENV_VAR = "PI_LIMITS_WAIT_MAX_RETRY";
export const RETRY_INTERVAL_ENV_VAR = "PI_LIMITS_WAIT_RETRY_INTERVAL";
export const LIVELINESS_INTERVAL_ENV_VAR = "PI_LIMITS_WAIT_LIVELINESS_INTERVAL";
/** Set to false/0/no/off to suppress the structured status channel. */
export const STATUS_JSON_ENV_VAR = "PI_LIMITS_WAIT_STATUS_JSON";
/** Absolute path of the out-of-band control file polled while waiting. Unset => no control. */
export const CONTROL_FILE_ENV_VAR = "PI_LIMITS_WAIT_CONTROL_FILE";
