import { readFileSync } from "fs";

const auth = JSON.parse(readFileSync(process.env.HOME + "/.pi/agent/auth.json", "utf8"));
const TOKEN = auth.anthropic.access;

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
  "anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
  "anthropic-dangerous-direct-browser-access": "true",
  "anthropic-version": "2023-06-01",
  authorization: `Bearer ${TOKEN}`,
  "content-type": "application/json",
  "user-agent": "claude-cli/2.1.75",
  "x-app": "cli",
};

const stainless091 = {
  "x-stainless-arch": "x64",
  "x-stainless-lang": "js",
  "x-stainless-os": "Windows",
  "x-stainless-package-version": "0.91.1",
  "x-stainless-retry-count": "0",
  "x-stainless-runtime": "node",
  "x-stainless-runtime-version": "v26.2.0",
  "x-stainless-timeout": "300",
};
const stainless094 = {
  ...stainless091,
  "x-stainless-package-version": "0.94.0",
  "x-stainless-runtime-version": "v26.3.0",
  "x-stainless-timeout": "600",
};

async function run(label, headers) {
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers, body: PI_BODY });
    let t = "";
    if (res.body) { for await (const c of res.body) { t += new TextDecoder().decode(c); if (t.length > 240) break; } }
    else t = await res.text();
    console.log(`${res.ok ? "OK " : "FAIL"} ${res.status} ${label}\n     ${t.slice(0, 240)}\n`);
  } catch (e) {
    console.log(`ERR  ${label}: ${e.message}\n`);
  }
}

await run("1 no x-stainless", baseHeaders);
await run("2 + x-stainless 0.91.1 (pi exact)", { ...baseHeaders, ...stainless091 });
await run("3 + x-stainless 0.94.0 (cc exact)", { ...baseHeaders, ...stainless094 });
