import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Api, Context, Model, SimpleStreamOptions } from "@mariozechner/pi-ai";
import { CLAUDE_CODE_IDENTITY, CLAUDE_CODE_IDENTITY_PATTERN, PI_IDENTITY_SENTENCE_PATTERN, PI_REMOVAL_ANCHORS } from "./constants.js";
import { state } from "./state.js";

export function sanitiseSystemPrompt(raw: string): string {
  const paragraphs = raw.split(/\n\n+/);
  const filtered = paragraphs.filter((p) =>
    !PI_REMOVAL_ANCHORS.some((anchor) => p.includes(anchor)),
  );

  return filtered
    .join("\n\n")
    .replace(CLAUDE_CODE_IDENTITY_PATTERN, "")
    .replace(PI_IDENTITY_SENTENCE_PATTERN, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Returns true if Anthropic OAuth is configured for this session, regardless
 * of which model is currently active. This handles cases where a synthetic or
 * temporary model is active at before_agent_start time.
 */
export function isAnthropicOAuthSession(ctx: ExtensionContext): boolean {
  return ctx.modelRegistry.isUsingOAuth(
    { provider: "anthropic" } as Parameters<typeof ctx.modelRegistry.isUsingOAuth>[0],
  );
}

export function isAnthropicOAuthToken(value: string | undefined): boolean {
  return Boolean(value?.includes("sk-ant-oat"));
}

function headerValue(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const direct = headers[name];
  if (direct !== undefined) return direct;
  const lower = name.toLowerCase();
  return Object.entries(headers).find(([key]) => key.toLowerCase() === lower)?.[1];
}

function requestAuthIsAnthropicOAuth(options?: SimpleStreamOptions): boolean | undefined {
  if (typeof options?.apiKey === "string" && options.apiKey.length > 0) {
    return isAnthropicOAuthToken(options.apiKey);
  }

  const authorization = headerValue(options?.headers, "authorization");
  if (authorization) {
    const bearer = authorization.match(/^\s*Bearer\s+(.+?)\s*$/i)?.[1] ?? authorization;
    return isAnthropicOAuthToken(bearer);
  }

  return undefined;
}

export function isAnthropicSubscriptionRequest(
  model: Model<Api>,
  options?: SimpleStreamOptions,
  ctx: ExtensionContext | undefined = state.sharedCtx,
): boolean {
  if (model.provider !== "anthropic") return false;

  // Prefer the actual per-request auth. This avoids both false negatives
  // (OAuth token supplied via options/fallback auth while modelRegistry does not
  // report OAuth) and false positives (registry has OAuth, but this request was
  // explicitly made with a normal API key).
  const requestAuth = requestAuthIsAnthropicOAuth(options);
  if (requestAuth !== undefined) return requestAuth;

  return Boolean(ctx?.modelRegistry.isUsingOAuth(model));
}

export function anthropicSubscriptionContext(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
  ctx: ExtensionContext | undefined = state.sharedCtx,
): Context {
  if (!isAnthropicSubscriptionRequest(model, options, ctx)) return context;

  const sanitised = sanitiseSystemPrompt(context.systemPrompt ?? "");
  return {
    ...context,
    systemPrompt: sanitised
      ? `${CLAUDE_CODE_IDENTITY}\n\n${sanitised}`
      : CLAUDE_CODE_IDENTITY,
  };
}
