import { createRequire } from "module";
import { readFileSync } from "fs";

const PI = "C:/Users/MaSliusareva/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent";
const require = createRequire(PI + "/");
const undici = require(PI + "/node_modules/undici");

// Use pi's EXACT captured headers (includes the live refreshed token) and body.
const headers = JSON.parse(readFileSync("./pi-headers.json", "utf8"));
const body = readFileSync("./pi-body.json", "utf8");

console.log("token used:", headers.authorization.slice(0, 30) + "...");
console.log("body bytes:", body.length);

async function run(label, opts = {}) {
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers, body, ...opts });
    const t = await r.text();
    console.log(`${r.ok ? "OK " : "FAIL"} ${r.status} ${label}\n     ${t.slice(0, 180)}\n`);
  } catch (e) { console.log(`ERR  ${label}: ${e.message}\n`); }
}

console.log("=== A) native globalThis.fetch, pi's exact body+headers ===");
await run("native-fetch");

console.log("=== B) undici.fetch, pi's exact body+headers ===");
await run("undici-fetch", { _useUndici: true });

// Redo B properly via undici.fetch directly
console.log("=== B2) undici.fetch (explicit) ===");
try {
  const r = await undici.fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers, body });
  const t = await r.text();
  console.log(`${r.ok ? "OK " : "FAIL"} ${r.status} undici-fetch\n     ${t.slice(0, 180)}\n`);
} catch (e) { console.log(`ERR  undici-fetch: ${e.message}\n`); }

console.log("=== C) undici.request (lowest level) ===");
try {
  const r = await undici.request("https://api.anthropic.com/v1/messages", { method: "POST", headers, body });
  const t = await r.body.text();
  console.log(`${r.statusCode >= 200 && r.statusCode < 300 ? "OK " : "FAIL"} ${r.statusCode} undici-request\n     ${t.slice(0, 180)}\n`);
} catch (e) { console.log(`ERR  undici-request: ${e.message}\n`); }
