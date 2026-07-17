import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Api, Context, Model, SimpleStreamOptions } from "@mariozechner/pi-ai";
import { CLAUDE_CODE_IDENTITY, CLAUDE_CODE_IDENTITY_PATTERN, PI_HARNESS_IDENTITY_PATTERN, PI_IDENTITY_SENTENCE_PATTERN, PI_REMOVAL_ANCHORS } from "./constants.js";
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
    .replace(PI_HARNESS_IDENTITY_PATTERN, "")
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

interface SystemTextBlock {
  type: string;
  text?: unknown;
  [key: string]: unknown;
}

function isClaudeCodeIdentityBlock(block: unknown): block is SystemTextBlock {
  if (!block || typeof block !== "object") return false;
  const b = block as SystemTextBlock;
  return b.type === "text" && typeof b.text === "string" && b.text.includes(CLAUDE_CODE_IDENTITY);
}

/**
 * Sanitise the `system` blocks of an Anthropic provider request payload.
 *
 * Anthropic now rejects Claude Pro/Max (OAuth) requests whose system prompt
 * still carries third-party-agent fingerprints (e.g. pi-coding-agent paths or
 * "You are pi" identity). pi-ai already prepends the Claude Code identity as
 * the first `system` block for OAuth tokens, but passes the host agent's full
 * system prompt through as a second block unchanged, which trips the check.
 *
 * This runs from the `before_provider_request` extension hook, which fires for
 * every provider request and whose return value replaces the outbound payload.
 * It only touches payloads that already carry the Claude Code identity block
 * (i.e. Anthropic OAuth requests), so API-key Anthropic calls and non-Anthropic
 * providers are left untouched. Each remaining text block is run through
 * `sanitiseSystemPrompt`; blocks that become empty are dropped.
 */
export function sanitiseAnthropicPayloadSystem(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") return payload;
  const system = (payload as { system?: unknown }).system;
  if (!Array.isArray(system)) return payload;

  const identityIndex = system.findIndex(isClaudeCodeIdentityBlock);
  if (identityIndex === -1) return payload;

  const newSystem: unknown[] = [];
  for (let i = 0; i < system.length; i++) {
    const block = system[i];
    if (i === identityIndex) {
      newSystem.push(block);
      continue;
    }
    if (
      block && typeof block === "object"
      && (block as SystemTextBlock).type === "text"
      && typeof (block as SystemTextBlock).text === "string"
    ) {
      const sanitised = sanitiseSystemPrompt((block as SystemTextBlock).text as string);
      if (sanitised) newSystem.push({ ...block, text: sanitised });
    } else {
      newSystem.push(block);
    }
  }

  return { ...payload, system: newSystem };
}
