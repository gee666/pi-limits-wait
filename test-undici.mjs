import { createRequire } from "module";

const UNDICI_PATH = "C:/Users/MaSliusareva/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent/node_modules/undici";
const require = createRequire(UNDICI_PATH + "/");
const undici = require(UNDICI_PATH);

const URL = "http://127.0.0.1:8877/v1/messages";
const headers = {
  accept: "application/json",
  "anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
  "anthropic-version": "2023-06-01",
  authorization: "Bearer test-token",
  "content-type": "application/json",
  "user-agent": "claude-cli/2.1.75",
  "x-app": "cli",
};
const body = JSON.stringify({ model: "claude-opus-4-8", messages: [{ role: "user", content: "hi" }] });

console.log("=== A) npm undici fetch (default, no global dispatcher set) ===");
try {
  const r = await undici.fetch(URL, { method: "POST", headers, body });
  await r.text();
  console.log("undici fetch status:", r.status);
} catch (e) { console.log("undici fetch err:", e.message); }

console.log("\n=== B) Node built-in fetch (globalThis.fetch) ===");
try {
  const r = await fetch(URL, { method: "POST", headers, body });
  await r.text();
  console.log("builtin fetch status:", r.status);
} catch (e) { console.log("builtin fetch err:", e.message); }

console.log("\n=== C) npm undici fetch with EnvHttpProxyAgent global dispatcher (like pi) ===");
try {
  const agent = new undici.EnvHttpProxyAgent({ allowH2: false, bodyTimeout: 300000, headersTimeout: 300000 });
  undici.setGlobalDispatcher(agent);
  const r = await undici.fetch(URL, { method: "POST", headers, body });
  await r.text();
  console.log("undici+envproxy fetch status:", r.status);
} catch (e) { console.log("undici+envproxy fetch err:", e.message); }
