import { readFileSync } from "fs";

const headers = JSON.parse(readFileSync("./pi-headers.json", "utf8"));
const origBody = JSON.parse(readFileSync("./pi-body.json", "utf8"));

async function run(label, body) {
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers, body: JSON.stringify(body) });
    const t = await r.text();
    const ok = r.ok;
    // For streaming, read first chunk
    let preview = t.slice(0, 120);
    console.log(`${ok ? "OK " : "FAIL"} ${r.status} ${label}\n     ${preview}\n`);
  } catch (e) { console.log(`ERR  ${label}: ${e.message}\n`); }
}

const ccIdentity = "You are Claude Code, Anthropic's official CLI for Claude.";
const piPrompt = origBody.system[1].text;

// 1: only Claude Code identity, no second block
await run("1 single CC block only", { ...origBody, system: [{ type: "text", text: ccIdentity }] });

// 2: CC + benign second block
await run("2 CC + benign 2nd block", { ...origBody, system: [{ type: "text", text: ccIdentity }, { type: "text", text: "Help the user with coding tasks." }] });

// 3: CC + raw pi prompt 2nd block (the failing case, as string system)
await run("3 CC + raw pi 2nd block (status quo)", origBody);

// 4: CC + pi prompt with 'pi'/'pi-coding-agent' redacted
const redacted = piPrompt.replace(/pi-coding-agent/g, "cli").replace(/\bpi\b/g, "the CLI").replace(/Pi /g, "CLI ");
await run("4 CC + redacted pi 2nd block", { ...origBody, system: [{ type: "text", text: ccIdentity }, { type: "text", text: redacted }] });

// 5: CC + just the "operating inside pi" sentence
await run("5 CC + 'operating inside pi' only", { ...origBody, system: [{ type: "text", text: ccIdentity }, { type: "text", text: "You are an expert coding assistant operating inside pi, a coding agent harness." }] });

// 6: CC + 'operating inside pi' with pi->CLI
await run("6 CC + 'operating inside the CLI' only", { ...origBody, system: [{ type: "text", text: ccIdentity }, { type: "text", text: "You are an expert coding assistant operating inside the CLI, a coding agent harness." }] });
