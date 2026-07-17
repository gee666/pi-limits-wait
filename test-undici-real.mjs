import { createRequire } from "module";
import { readFileSync } from "fs";

const UNDICI_PATH = "C:/Users/MaSliusareva/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent/node_modules/undici";
const require = createRequire(UNDICI_PATH + "/");
const undici = require(UNDICI_PATH);

const auth = JSON.parse(readFileSync(process.env.HOME + "/.pi/agent/auth.json", "utf8"));
const TOKEN = auth.anthropic.access;

const URL = "https://api.anthropic.com/v1/messages";
const headers = {
  accept: "application/json",
  "anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
  "anthropic-dangerous-direct-browser-access": "true",
  "anthropic-version": "2023-06-01",
  authorization: `Bearer ${TOKEN}`,
  "content-type": "application/json",
  "user-agent": "claude-cli/2.1.75",
  "x-app": "cli",
};
const body = JSON.stringify({
  model: "claude-opus-4-8",
  max_tokens: 16,
  stream: false,
  system: [{ type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." }],
  messages: [{ role: "user", content: "Reply with exactly: ok" }],
});

async function result(fetchFn, label) {
  try {
    const r = await fetchFn();
    const t = await r.text();
    console.log(`${r.ok ? "OK " : "FAIL"} ${r.status} ${label}\n     ${t.slice(0, 180)}\n`);
  } catch (e) { console.log(`ERR  ${label}: ${e.message}\n`); }
}

console.log("=== A) npm undici fetch (default dispatcher) ===");
await result(() => undici.fetch(URL, { method: "POST", headers, body }), "undici default");

console.log("=== B) Node built-in fetch ===");
await result(() => fetch(URL, { method: "POST", headers, body }), "node builtin");

console.log("=== C) npm undici fetch + EnvHttpProxyAgent global dispatcher (pi-like) ===");
undici.setGlobalDispatcher(new undici.EnvHttpProxyAgent({ allowH2: false, bodyTimeout: 300000, headersTimeout: 300000 }));
await result(() => undici.fetch(URL, { method: "POST", headers, body }), "undici+envproxy");

console.log("=== D) npm undici fetch with explicit default Agent dispatcher ===");
await result(() => undici.fetch(URL, { method: "POST", headers, body, dispatcher: new undici.Agent() }), "undici+defaultAgent");
