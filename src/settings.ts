import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";
import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { FALLBACK_MODELS_KEY, SETTINGS_FILE_NAME } from "./constants.js";
import { formatModel, modelKey } from "./models.js";
import { state } from "./state.js";
import type { ConfiguredModel } from "./types.js";

function isThinkingLevel(value: unknown): value is ModelThinkingLevel {
  return ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(String(value));
}

export function parseConfiguredModels(raw: unknown): ConfiguredModel[] {
  const source = raw && typeof raw === "object" && Array.isArray((raw as { [FALLBACK_MODELS_KEY]?: unknown })[FALLBACK_MODELS_KEY])
    ? (raw as { [FALLBACK_MODELS_KEY]: unknown[] })[FALLBACK_MODELS_KEY]
    : [];

  const models: ConfiguredModel[] = [];
  for (const item of source) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const provider = typeof record.provider === "string" ? record.provider.trim() : "";
    const modelname =
      typeof record.modelname === "string" ? record.modelname.trim()
      : typeof record.modelName === "string" ? record.modelName.trim()
      : typeof record.model === "string" ? record.model.trim()
      : "";
    const reasoning = record["reasoning effort"] ?? record.reasoningEffort ?? record.reasoning_effort;
    if (!provider || !modelname) continue;
    models.push({ provider, modelname, reasoningEffort: isThinkingLevel(reasoning) ? reasoning : undefined });
  }
  return models;
}

export function configFileCandidates(
  cwd: string,
  agentDir = getAgentDir(),
  homeDir = homedir(),
  isProjectTrusted = false,
): string[] {
  const alwaysLoaded = [
    join(homeDir, ".config", ".pi", SETTINGS_FILE_NAME),
    join(agentDir, SETTINGS_FILE_NAME),
  ];
  return isProjectTrusted
    ? [...alwaysLoaded, resolve(cwd, `.${SETTINGS_FILE_NAME}`), resolve(cwd, ".pi", SETTINGS_FILE_NAME)]
    : alwaysLoaded;
}

function mergeConfig(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  return { ...base, ...override };
}

export function readFallbackSettings(
  cwd: string,
  agentDir = getAgentDir(),
  homeDir = homedir(),
  isProjectTrusted = false,
): { config: Record<string, unknown>; loadedPaths: string[]; warnings: string[] } {
  let config: Record<string, unknown> = {};
  const loadedPaths: string[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();

  for (const candidate of configFileCandidates(cwd, agentDir, homeDir, isProjectTrusted)) {
    const path = resolve(candidate);
    if (seen.has(path)) continue;
    seen.add(path);
    if (!existsSync(path)) continue;

    try {
      const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        warnings.push(`${path}: expected a JSON object`);
        continue;
      }
      config = mergeConfig(config, parsed as Record<string, unknown>);
      loadedPaths.push(path);
    } catch (err) {
      warnings.push(`${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { config, loadedPaths, warnings };
}

export function __readFallbackSettingsForTests(
  cwd: string,
  agentDir: string,
  homeDir: string,
  isProjectTrusted: boolean,
): { config: Record<string, unknown>; loadedPaths: string[]; warnings: string[] } {
  return readFallbackSettings(cwd, agentDir, homeDir, isProjectTrusted);
}

export function loadFallbackSettings(ctx: ExtensionContext): void {
  state.fallbackModels = [];

  try {
    const { config, loadedPaths, warnings } = readFallbackSettings(
      ctx.cwd,
      getAgentDir(),
      homedir(),
      typeof ctx.isProjectTrusted === "function" && ctx.isProjectTrusted(),
    );
    const content = JSON.stringify({ config, loadedPaths, warnings });
    const shouldNotify = state.settingsSignature !== content;
    state.settingsSignature = content;

    const configured = parseConfiguredModels(config);
    if (configured.length === 0) {
      if (shouldNotify && warnings.length > 0) ctx.ui.notify(`Could not fully load ${SETTINGS_FILE_NAME}: ${warnings.join(", ")}`, "warning");
      return;
    }

    const modelWarnings: string[] = [];
    const seen = new Set<string>();

    for (const entry of configured) {
      const model = ctx.modelRegistry.find(entry.provider, entry.modelname);
      if (!model) {
        modelWarnings.push(`missing ${entry.provider}/${entry.modelname}`);
        continue;
      }
      if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
        modelWarnings.push(`no auth ${entry.provider}/${entry.modelname}`);
        continue;
      }
      const key = modelKey(model);
      if (seen.has(key)) continue;
      seen.add(key);
      state.fallbackModels.push({ model, reasoningEffort: entry.reasoningEffort });
    }

    const lines = state.fallbackModels.map((entry, index) =>
      `${index + 1}. ${formatModel(entry.model)}${entry.reasoningEffort ? ` (${entry.reasoningEffort})` : ""}`,
    );
    const source = loadedPaths.length > 0 ? ` from ${loadedPaths.join(", ")}` : "";
    const message = lines.length > 0
      ? `Loaded ${SETTINGS_FILE_NAME}.${FALLBACK_MODELS_KEY}${source}:\n${lines.join("\n")}`
      : `Loaded ${SETTINGS_FILE_NAME}.${FALLBACK_MODELS_KEY}${source}, but no usable fallback models were found.`;
    const allWarnings = [...warnings, ...modelWarnings];
    if (shouldNotify) {
      ctx.ui.notify(allWarnings.length > 0 ? `${message}\nSkipped: ${allWarnings.join(", ")}` : message, allWarnings.length > 0 ? "warning" : "info");
    }
  } catch (err) {
    ctx.ui.notify(`Could not load ${SETTINGS_FILE_NAME}.${FALLBACK_MODELS_KEY}: ${err instanceof Error ? err.message : String(err)}`, "warning");
  }
}
