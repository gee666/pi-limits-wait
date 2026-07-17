import { createRequire } from "module";
import { readFileSync, writeFileSync } from "fs";
import { randomUUID } from "crypto";

const PI_AI_DIR = "C:/Users/MaSliusareva/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai";
const require = createRequire(PI_AI_DIR + "/");
const piAi = require(PI_AI_DIR + "/dist/index.js");

const auth = JSON.parse(readFileSync(process.env.HOME + "/.pi/agent/auth.json", "utf8"));
const TOKEN = auth.anthropic.access;

writeFileSync("./pi-request.log", "");
const origFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  try {
    const url = typeof input === "string" ? input : input.url;
    const headers = {};
    const h = init?.headers;
    if (h) {
      if (h instanceof Headers) for (const [k, v] of h.entries()) headers[k] = v;
      else if (Array.isArray(h)) for (const [k, v] of h) headers[k] = v;
      else Object.assign(headers, h);
    }
    let body = init?.body;
    let bodyStr = "";
    if (typeof body === "string") bodyStr = body;
    else if (body) bodyStr = String(body);
    writeFileSync("./pi-request.log", JSON.stringify({ url, headers, bodyPreview: bodyStr.slice(0, 6000) }, null, 2));
  } catch (e) {
    writeFileSync("./pi-request.log", "log error: " + e.message);
  }
  return origFetch(input, init);
};

const model = {
  id: "claude-opus-4-8",
  name: "Claude Opus 4.8",
  api: "anthropic-messages",
  provider: "anthropic",
  baseUrl: "https://api.anthropic.com",
  compat: { forceAdaptiveThinking: true, supportsTemperature: false },
  reasoning: true,
  thinkingLevelMap: { xhigh: "xhigh", max: "max" },
  input: ["text", "image"],
  cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  contextWindow: 1000000,
  maxTokens: 128000,
};

// Mirror what the extension produces: Claude Code identity prepended to a pi-style system prompt.
const piSystemPrompt = "You are pi, a coding agent.\n\nFollow the user's instructions carefully.";
const systemPrompt = "You are Claude Code, Anthropic's official CLI for Claude.\n\n" + piSystemPrompt;

const context = {
  systemPrompt,
  messages: [{ role: "user", content: "Reply with exactly: ok" }],
  tools: [],
};

const options = { apiKey: TOKEN, reasoning: "medium" };

console.log("calling pi-ai streamSimple (opus-4-8, OAuth)...");
try {
  const stream = piAi.streamSimple(model, context, options);
  let lastEvent;
  for await (const event of stream) {
    lastEvent = event;
    if (event.type === "error") {
      console.log("ERROR EVENT:", event.reason, JSON.stringify(event.error?.errorMessage ?? "").slice(0, 300));
      break;
    }
    if (event.type === "done") {
      console.log("DONE:", event.reason);
      break;
    }
  }
} catch (e) {
  console.log("THREW:", e.message);
}
