import { readFileSync } from "fs";
import { randomUUID } from "crypto";

const auth = JSON.parse(readFileSync(process.env.HOME + "/.pi/agent/auth.json", "utf8"));
const TOKEN = auth.anthropic.access;

const URL = "https://api.anthropic.com/v1/messages?beta=true";
const BODY = JSON.stringify({
  model: "claude-opus-4-8",
  max_tokens: 16,
  stream: false,
  system: [{ type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." }],
  messages: [{ role: "user", content: "Reply with exactly: ok" }],
});

const stainless = {
  "x-stainless-arch": "x64",
  "x-stainless-lang": "js",
  "x-stainless-os": "Windows",
  "x-stainless-package-version": "0.94.0",
  "x-stainless-retry-count": "0",
  "x-stainless-runtime": "node",
  "x-stainless-runtime-version": "v26.3.0",
  "x-stainless-timeout": "600",
};

const common = {
  authorization: `Bearer ${TOKEN}`,
  "content-type": "application/json",
  accept: "application/json",
  "anthropic-version": "2023-06-01",
  "anthropic-dangerous-direct-browser-access": "true",
  "x-app": "cli",
  ...stainless,
};

const PI_UA = "claude-cli/2.1.75";
const CC_UA = "claude-cli/2.1.212 (external, sdk-cli)";
const PI_BETA = "claude-code-20250219,oauth-2025-04-20,fine-grained-tool-streaming-2025-05-14,interleaved-thinking-2025-05-14";
const CC_BETA = "claude-code-20250219,oauth-2025-04-20,context-1m-2025-08-07,interleaved-thinking-2025-05-14,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05,mid-conversation-system-2026-04-07,advisor-tool-2026-03-01,effort-2025-11-24,extended-cache-ttl-2025-04-11";

const cases = [
  ["A pi-baseline (expect FAIL)", { "user-agent": PI_UA, "anthropic-beta": PI_BETA }],
  ["B real-cc full (expect OK)", { "user-agent": CC_UA, "anthropic-beta": CC_BETA, "x-claude-code-session-id": randomUUID() }],
  ["C pi + cc UA only", { "user-agent": CC_UA, "anthropic-beta": PI_BETA }],
  ["D pi + cc beta only", { "user-agent": PI_UA, "anthropic-beta": CC_BETA }],
  ["E pi + session-id only", { "user-agent": PI_UA, "anthropic-beta": PI_BETA, "x-claude-code-session-id": randomUUID() }],
  ["F pi + cc UA + cc beta", { "user-agent": CC_UA, "anthropic-beta": CC_BETA }],
  ["G pi + cc UA + session-id", { "user-agent": CC_UA, "anthropic-beta": PI_BETA, "x-claude-code-session-id": randomUUID() }],
];

for (const [label, extra] of cases) {
  try {
    const res = await fetch(URL, { method: "POST", headers: { ...common, ...extra }, body: BODY });
    const text = await res.text();
    let summary = text;
    try { summary = JSON.stringify(JSON.parse(text)); } catch {}
    const ok = res.ok;
    console.log(`${ok ? "OK " : "FAIL"} ${res.status} ${label}\n     ${String(summary).slice(0, 220)}`);
  } catch (e) {
    console.log(`ERR  ${label}: ${e.message}`);
  }
}
