import { writeFileSync } from "fs";

const realFetch = globalThis.fetch?.bind(globalThis);
globalThis.fetch = async function (input, init) {
  const url = typeof input === "string" ? input : (input?.url ?? String(input));
  if (url.includes("anthropic.com")) {
    const body = typeof init?.body === "string" ? init.body : String(init?.body ?? "");
    writeFileSync("./pi-body-now.json", body);
  }
  return realFetch(input, init);
};

export default function () {}
