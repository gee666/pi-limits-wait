import { createRequire } from "module";
import { readFileSync } from "fs";

const PI = "C:/Users/MaSliusareva/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent";
const require = createRequire(PI + "/");
const Anthropic = require(PI + "/node_modules/@anthropic-ai/sdk").default || require(PI + "/node_modules/@anthropic-ai/sdk").Anthropic;

const auth = JSON.parse(readFileSync(process.env.HOME + "/.pi/agent/auth.json", "utf8"));
const TOKEN = auth.anthropic.access;

// Replicate pi's startup: install EnvHttpProxyAgent global dispatcher.
const { configureHttpDispatcher } = require(PI + "/dist/core/http-dispatcher.js");
configureHttpDispatcher(300000);
console.log("configureHttpDispatcher done. globalThis.fetch is:", globalThis.fetch === fetch ? "native" : "replaced");

// Replicate pi-ai's createClient (OAuth branch) exactly.
const client = new Anthropic({
  apiKey: null,
  authToken: TOKEN,
  baseURL: "https://api.anthropic.com",
  dangerouslyAllowBrowser: true,
  defaultHeaders: {
    accept: "application/json",
    "anthropic-dangerous-direct-browser-access": "true",
    "anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
    "user-agent": "claude-cli/2.1.75",
    "x-app": "cli",
  },
});

// Replicate pi-ai's buildParams (OAuth) body.
const params = {
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
};

console.log("\n=== SDK client.messages.create (pi-ai exact path) ===");
try {
  const response = await client.messages.create({ ...params, stream: true }, { maxRetries: 0 }).asResponse();
  let t = "";
  for await (const chunk of response.body) { t += new TextDecoder().decode(chunk); if (t.length > 200) break; }
  console.log(`${response.ok ? "OK " : "FAIL"} ${response.status}\n     ${t.slice(0, 200)}`);
} catch (e) {
  console.log("THREW:", e.status, e.message?.slice(0, 200));
}
