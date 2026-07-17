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

const paras = piPrompt.split(/\n\n+/);
console.log(`pi prompt has ${paras.length} paragraphs:\n`);
paras.forEach((p, i) => console.log(`[${i}] (${p.length}ch) ${p.slice(0, 70).replace(/\n/g, " ")}...`));
console.log("");

// Test cumulative
for (let i = 1; i <= paras.length; i++) {
  await run(`paras 0..${i - 1}`, paras.slice(0, i).join("\n\n"));
}
