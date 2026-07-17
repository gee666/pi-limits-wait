import { createRequire } from "module";
import { readFileSync } from "fs";

const PI_CORE = "C:/Users/MaSliusareva/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent";
const require = createRequire(PI_CORE + "/");

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

console.log("globalThis.fetch before configure:", globalThis.fetch === fetch ? "native" : "other");

// Replicate pi's exact startup.
const { configureHttpDispatcher } = require(PI_CORE + "/dist/core/http-dispatcher.js");
configureHttpDispatcher(300000);

console.log("globalThis.fetch after configure:", globalThis.fetch === fetch ? "native" : "replaced-by-undici-install");

console.log("\n=== A) globalThis.fetch after configureHttpDispatcher (pi-exact) ===");
try {
  const r = await globalThis.fetch(URL, { method: "POST", headers, body });
  const t = await r.text();
  console.log(`${r.ok ? "OK " : "FAIL"} ${r.status}\n     ${t.slice(0, 200)}`);
} catch (e) { console.log("ERR:", e.message); }

console.log("\n=== B) same, but bypass with a fresh undici.Agent dispatcher ===");
const undici = require(PI_CORE + "/node_modules/undici");
try {
  const r = await globalThis.fetch(URL, { method: "POST", headers, body, dispatcher: new undici.Agent() });
  const t = await r.text();
  console.log(`${r.ok ? "OK " : "FAIL"} ${r.status}\n     ${t.slice(0, 200)}`);
} catch (e) { console.log("ERR:", e.message); }
