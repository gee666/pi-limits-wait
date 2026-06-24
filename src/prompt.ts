import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Api, Context, Model } from "@mariozechner/pi-ai";
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

export function anthropicSubscriptionContext(model: Model<Api>, context: Context): Context {
  if (model.provider !== "anthropic" || !state.sharedCtx?.modelRegistry.isUsingOAuth(model)) return context;

  const sanitised = sanitiseSystemPrompt(context.systemPrompt ?? "");
  return {
    ...context,
    systemPrompt: sanitised
      ? `${CLAUDE_CODE_IDENTITY}\n\n${sanitised}`
      : CLAUDE_CODE_IDENTITY,
  };
}
