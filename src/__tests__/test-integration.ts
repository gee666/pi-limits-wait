import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream, InMemoryCredentialStore, type AssistantMessage,
} from "@earendil-works/pi-ai";
import limitsWaitExtension, { disableModelRuntimeInterception } from "../index.js";

// Unlike the runtime-level suite, drive a real session and its extension runner:
// settings -> fallback -> same-model retry -> turn_end metadata -> next turn.
const root = mkdtempSync(join(tmpdir(), "limits-wait-integration-"));
const savedEnv = { ...process.env };
let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
try {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("PI_LIMITS_WAIT_")) delete process.env[key];
  }
  process.env.HOME = root;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  process.env.PI_LIMITS_WAIT_RETRY_INTERVAL = "0";
  process.env.PI_LIMITS_WAIT_MAX_RETRY = "1";
  process.env.PI_LIMITS_WAIT_PROBE_INTERVAL = "0";
  mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
  writeFileSync(join(process.env.PI_CODING_AGENT_DIR, "limits-wait.json"), JSON.stringify({
    "fallback-models": ["primary", "fallback"].map((provider) => ({ provider, modelname: "fixture" })),
  }));

  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false,
  });
  const calls: string[] = [];
  const contexts: string[] = [];
  let fallbackAttempts = 0;
  for (const provider of ["primary", "fallback"]) {
    runtime.registerProvider(provider, {
      api: "openai-completions", baseUrl: "https://fixture.invalid", apiKey: "dummy-key",
      models: [{
        id: "fixture", name: provider, reasoning: false, input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000, maxTokens: 256,
      }],
      streamSimple(model, context) {
        calls.push(provider);
        contexts.push(JSON.stringify(context));
        const failure = provider === "primary" ? "HTTP 429 retry-after 60"
          : ++fallbackAttempts === 1 ? "integration transient unknown failure" : undefined;
        const message: AssistantMessage = {
          role: "assistant", api: model.api, provider: model.provider, model: model.id,
          content: failure ? [] : [{ type: "text", text: "integration recovered" }],
          stopReason: failure ? "error" : "stop", timestamp: Date.now(),
          ...(failure ? { errorMessage: failure } : {}),
          usage: {
            input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        };
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => {
          stream.push({ type: "start", partial: message });
          if (failure) stream.push({ type: "error", reason: "error", error: message });
          else stream.push({ type: "done", reason: "stop", message });
          stream.end();
        });
        return stream;
      },
    });
  }
  const settingsManager = SettingsManager.inMemory({
    retry: { enabled: false }, compaction: { enabled: false },
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd: root, agentDir: process.env.PI_CODING_AGENT_DIR, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
    extensionFactories: [limitsWaitExtension],
  });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, []);
  const sessionManager = SessionManager.inMemory(root);
  ({ session } = await createAgentSession({
    cwd: root, agentDir: process.env.PI_CODING_AGENT_DIR, modelRuntime: runtime,
    model: runtime.getModel("primary", "fixture"), thinkingLevel: "off",
    resourceLoader, settingsManager, sessionManager, tools: [],
  }));
  await session.bindExtensions({});
  await session.prompt("First integration turn");
  assert.deepEqual(calls, ["primary", "fallback", "fallback"]);
  assert.equal(session.model?.provider, "fallback", "successful fallback becomes the session model");
  assert.equal(session.getLastAssistantText(), "integration recovered");
  const summaries = () => sessionManager.getEntries().filter(
    (entry) => entry.type === "custom" && entry.customType === "limits-wait",
  );
  const summary = summaries()[0];
  assert.ok(summary?.type === "custom");
  assert.deepEqual(summary.data, {
    totalWaitingTime: 0,
    reasons: ["HTTP 429 retry-after 60", "integration transient unknown failure"],
    retries_total: 2,
  }, "turn_end records both immediate fallback and zero-wait retry exactly once");

  await session.prompt("Second integration turn");
  assert.deepEqual(calls, ["primary", "fallback", "fallback", "fallback"],
    "next turn stays on fallback while the explicit primary deadline is active");
  assert.equal(summaries().length, 1, "healthy turns do not duplicate retry metadata");
  const nextContext = contexts.at(-1);
  assert.ok(nextContext);
  assert.ok(nextContext.includes("integration recovered"), "successful response enters next-turn context");
  assert.ok(!nextContext.includes("integration transient unknown failure"));
  assert.ok(!nextContext.includes("retries_total"), "retry summaries stay outside model context");
  assert.equal(session.messages.filter((message) => message.role === "assistant").length, 2,
    "failed attempts never become extra assistant turns");
  console.log("✅ SDK session fallback, retry, summary lifecycle and next-turn context");
} finally {
  session?.dispose();
  disableModelRuntimeInterception();
  process.env = savedEnv;
  rmSync(root, { recursive: true, force: true });
}
