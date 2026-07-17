import { readFileSync } from "fs";

const headers = JSON.parse(readFileSync("./pi-headers.json", "utf8"));
const origBody = JSON.parse(readFileSync("./pi-body.json", "utf8"));
const ccIdentity = "You are Claude Code, Anthropic's official CLI for Claude.";
const piPrompt = origBody.system[1].text;

async function run(label, secondText) {
  const body = { ...origBody, system: [{ type: "text", text: ccIdentity }, { type: "text", text: secondText }] };
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers, body: JSON.stringify(body) });
    const t = await r.text();
    console.log(`${r.ok ? "OK " : "FAIL"} ${r.status} ${label}`);
  } catch (e) { console.log(`ERR  ${label}: ${e.message}`); }
}

// Isolate which substring triggers. Use minimal sentences.
await run("a '@earendil-works/pi-coding-agent'", "Some text @earendil-works/pi-coding-agent more text.");
await run("b 'pi-coding-agent' alone", "Some text pi-coding-agent more text.");
await run("c '@mariozechner/pi-coding-agent'", "Some text @mariozechner/pi-coding-agent more text.");
await run("d 'pi-coding-agent' in a path", "C:\\Users\\foo\\pi-coding-agent\\README.md");
await run("e 'badlogic/pi-mono'", "Some text badlogic/pi-mono more text.");
await run("f 'earendil-works' alone", "Some text @earendil-works more text.");
await run("g 'coding-agent' alone", "Some text coding-agent more text.");
await run("h full raw pi prompt (control)", piPrompt);
