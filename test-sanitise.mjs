import { readFileSync } from "fs";

const headers = JSON.parse(readFileSync("./pi-headers.json", "utf8"));
const origBody = JSON.parse(readFileSync("./pi-body.json", "utf8"));

// Replicate the extension's sanitiseSystemPrompt + anthropicSubscriptionContext logic.
const PI_REMOVAL_ANCHORS = ["pi-coding-agent", "@mariozechner/pi-coding-agent", "badlogic/pi-mono"];
const CLAUDE_CODE_IDENTITY_PATTERN = /(?:^|\n)\s*You are Claude Code, Anthropic's official CLI for Claude\.\s*/gi;
const PI_IDENTITY_SENTENCE_PATTERN = /(?:^|\n)\s*You are pi\b[^.!?\n]*(?:[.!?](?=\s|$)|(?=\n|$))/gi;

function sanitiseSystemPrompt(raw) {
  const paragraphs = raw.split(/\n\n+/);
  const filtered = paragraphs.filter((p) => !PI_REMOVAL_ANCHORS.some((anchor) => p.includes(anchor)));
  return filtered.join("\n\n").replace(CLAUDE_CODE_IDENTITY_PATTERN, "").replace(PI_IDENTITY_SENTENCE_PATTERN, "").replace(/\n{3,}/g, "\n\n").trim();
}

async function run(label, body) {
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers, body: JSON.stringify(body) });
    const t = await r.text();
    console.log(`${r.ok ? "OK " : "FAIL"} ${r.status} ${label}\n     ${t.slice(0, 120)}\n`);
  } catch (e) { console.log(`ERR  ${label}: ${e.message}\n`); }
}

// origBody.system = [CC identity block, pi prompt block]
console.log("=== original 2nd block (unsanitised) ===");
await run("unsanitised (control, expect FAIL)", origBody);

// Sanitise the 2nd block's text only.
const sanitised2nd = sanitiseSystemPrompt(origBody.system[1].text);
console.log("sanitised 2nd block:\n" + sanitised2nd.slice(0, 500) + "\n");
await run("2nd block sanitised (expect OK)", { ...origBody, system: [{ ...origBody.system[0] }, { ...origBody.system[1], text: sanitised2nd }] });

// Also test: sanitised + drop empty
await run("2nd block sanitised, drop if empty", { ...origBody, system: sanitised2nd ? [{ ...origBody.system[0] }, { ...origBody.system[1], text: sanitised2nd }] : [origBody.system[0]] });
