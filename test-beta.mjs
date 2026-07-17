import { readFileSync } from "fs";

const auth = JSON.parse(readFileSync(process.env.HOME + "/.pi/agent/auth.json", "utf8"));
const TOKEN = auth.anthropic.access;

const BODY_NONSTREAM = JSON.stringify({
  model: "claude-opus-4-8",
  max_tokens: 16,
  stream: false,
  system: [{ type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." }],
  messages: [{ role: "user", content: "Reply with exactly: ok" }],
});
const BODY_STREAM = JSON.stringify({
  model: "claude-opus-4-8",
  max_tokens: 16,
  stream: true,
  system: [{ type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." }],
  messages: [{ role: "user", content: "Reply with exactly: ok" }],
});

const headers = {
  authorization: `Bearer ${TOKEN}`,
  "content-type": "application/json",
  accept: "application/json",
  "anthropic-version": "2023-06-01",
  "anthropic-dangerous-direct-browser-access": "true",
  "x-app": "cli",
  "user-agent": "claude-cli/2.1.75",
  "anthropic-beta": "claude-code-20250219,oauth-2025-04-20,fine-grained-tool-streaming-2025-05-14,interleaved-thinking-2025-05-14",
};

async function run(label, url, body, stream) {
  try {
    const res = await fetch(url, { method: "POST", headers, body });
    let text;
    if (stream) {
      // read a bit of the stream
      let t = "";
      for await (const chunk of res.body) { t += new TextDecoder().decode(chunk); if (t.length > 200) break; }
      text = t;
    } else {
      text = await res.text();
    }
    const ok = res.ok;
    console.log(`${ok ? "OK " : "FAIL"} ${res.status} ${label}\n     ${String(text).slice(0, 200)}`);
  } catch (e) {
    console.log(`ERR  ${label}: ${e.message}`);
  }
}

await run("A1 no-beta, non-stream (pi-exact)", "https://api.anthropic.com/v1/messages", BODY_NONSTREAM, false);
await run("A2 no-beta, stream (pi-exact streaming)", "https://api.anthropic.com/v1/messages", BODY_STREAM, true);
await run("A3 WITH beta=true, non-stream", "https://api.anthropic.com/v1/messages?beta=true", BODY_NONSTREAM, false);
await run("A4 WITH beta=true, stream", "https://api.anthropic.com/v1/messages?beta=true", BODY_STREAM, true);
