import { readFileSync } from "fs";

const auth = JSON.parse(readFileSync(process.env.HOME + "/.pi/agent/auth.json", "utf8"));
const TOKEN = auth.anthropic.access;

// pi's exact captured body (streaming).
const PI_BODY = JSON.stringify({
  model: "claude-opus-4-8",
  messages: [{ role: "user", content: [{ type: "text", text: "Reply with exactly: ok", cache_control: { type: "ephemeral" } }] }],
  max_tokens: 128000,
  stream: true,
  system: [
    { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude.", cache_control: { type: "ephemeral" } },
    { type: "text", text: "You are an expert coding assistant operating inside pi, a coding agent harness.", cache_control: { type: "ephemeral" } },
  ],
  thinking: { type: "adaptive", display: "summarized" },
  output_config: { effort: "medium" },
});

const baseHeaders = {
  accept: "application/json",
  "anthropic-dangerous-direct-browser-access": "true",
  "anthropic-version": "2023-06-01",
  authorization: `Bearer ${TOKEN}`,
  "content-type": "application/json",
  "user-agent": "claude-cli/2.1.75",
  "x-app": "cli",
};

const BETA_2 = "claude-code-20250219,oauth-2025-04-20";
const BETA_4 = "claude-code-20250219,oauth-2025-04-20,fine-grained-tool-streaming-2025-05-14,interleaved-thinking-2025-05-14";
const BETA_CC = "claude-code-20250219,oauth-2025-04-20,context-1m-2025-08-07,interleaved-thinking-2025-05-14,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05,mid-conversation-system-2026-04-07,advisor-tool-2026-03-01,effort-2025-11-24,extended-cache-ttl-2025-04-11";

async function run(label, { beta = BETA_2, body = PI_BODY, url = "https://api.anthropic.com/v1/messages" } = {}) {
  try {
    const res = await fetch(url, { method: "POST", headers: { ...baseHeaders, "anthropic-beta": beta }, body });
    let t = "";
    if (res.body) { for await (const c of res.body) { t += new TextDecoder().decode(c); if (t.length > 240) break; } }
    else t = await res.text();
    console.log(`${res.ok ? "OK " : "FAIL"} ${res.status} ${label}\n     ${t.slice(0, 240)}\n`);
  } catch (e) {
    console.log(`ERR  ${label}: ${e.message}\n`);
  }
}

// Body variants
const bodyNoThinking = JSON.stringify({ ...JSON.parse(PI_BODY), thinking: undefined, output_config: undefined });
const bodySingleSys = JSON.stringify({ ...JSON.parse(PI_BODY), system: [{ type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." }] });
const bodyMax16 = JSON.stringify({ ...JSON.parse(PI_BODY), max_tokens: 16 });

await run("1 pi-exact (2 beta, full body)", { beta: BETA_2 });
await run("2 pi-exact body + 4 beta", { beta: BETA_4 });
await run("3 pi-exact body + CC beta (11)", { beta: BETA_CC });
await run("4 2 beta, no thinking/output_config", { beta: BETA_2, body: bodyNoThinking });
await run("5 2 beta, single system block", { beta: BETA_2, body: bodySingleSys });
await run("6 2 beta, max_tokens 16", { beta: BETA_2, body: bodyMax16 });
