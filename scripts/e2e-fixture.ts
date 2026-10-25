import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync } from "node:fs";

// Only dummy credentials and loopback transport are used in deterministic tests.
export default function (pi: ExtensionAPI) {
  const capture = process.env.LIMITS_WAIT_E2E_CAPTURE;
  if (capture) {
    pi.on("before_provider_request", (event) => {
      const payload = event.payload;
      if (!payload || typeof payload !== "object") return;
      if ("max_output_tokens" in payload) return { ...payload, max_output_tokens: 1024 };
      if ("max_tokens" in payload) return { ...payload, max_tokens: 1024 };
    });
    const previous = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      // Never persist headers or credentials. Only our isolated test transcript.
      const body = init?.body;
      const response = await previous(input, init);
      if (typeof body === "string") {
        appendFileSync(capture, JSON.stringify({ body: JSON.parse(body), status: response.status }) + "\n");
      }
      return response;
    };
  }
  if (process.env.LIMITS_WAIT_E2E_ENDPOINT) {
    pi.registerProvider("limits-wait-fixture", {
      baseUrl: process.env.LIMITS_WAIT_E2E_ENDPOINT,
      apiKey: "sk-ant-oat01-harmless-sentinel",
      api: "anthropic-messages",
      headers: { "x-source-secret": "SOURCE_SECRET_SENTINEL" },
      models: [{
        id: "sentinel", name: "Sentinel", reasoning: false, input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000, maxTokens: 256,
      }],
    });
  }
  if (process.env.LIMITS_WAIT_E2E_WORKSPACE) {
    pi.registerProvider("openai", {
      baseUrl: `${process.env.LIMITS_WAIT_E2E_ENDPOINT}/workspace`,
      apiKey: "WORKSPACE_KEY_SENTINEL",
      api: "openai-responses",
      models: [{
        id: "workspace", name: "Workspace", reasoning: false, input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000, maxTokens: 256,
      }],
    });
  }
  if (process.env.LIMITS_WAIT_E2E_FALLBACK) {
    pi.registerProvider("openrouter", {
      baseUrl: `${process.env.LIMITS_WAIT_E2E_ENDPOINT}/target`,
      apiKey: "TARGET_KEY_SENTINEL",
      api: "openai-completions",
      headers: { "x-target-config": "TARGET_CONFIG_SENTINEL", "x-delete-me": "DELETE_SENTINEL" },
      models: [{
        id: "target", name: "Target", reasoning: false, input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000, maxTokens: 256,
      }],
    });
    pi.on("before_provider_headers", (event) => {
      if (event.headers["x-target-config"]) {
        event.headers["x-target-hook"] = "TARGET_HOOK_SENTINEL";
        event.headers["x-delete-me"] = null;
        // 1.4 attribution is assembled AFTER this hook. Null must survive.
        event.headers["X-OpenRouter-Title"] = null;
      } else {
        event.headers["x-source-hook-secret"] = "SOURCE_HOOK_SECRET_SENTINEL";
      }
    });
    pi.on("provider_stream_event", (_event, ctx) => {
      ctx.ui.setStatus("e2e-provider-stream", "observed");
    });
  }
  pi.registerCommand("e2e-reload", {
    description: "Reload the isolated test runtime",
    handler: async (_args, ctx) => { await ctx.reload(); },
  });
  let turn = 0;
  pi.on("before_agent_start", (event) => {
    // Structured changes exercise Pi's real initial prompt and later deltas.
    event.systemPromptOptions.sections.evergreen =
      `KEEP_SENTINEL_${++turn}\n\npi-coding-agent FORBIDDEN_HOST_SENTINEL_${turn}`;
  });
}
