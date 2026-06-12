import { SettingsManager, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import { SETTINGS_KEY } from "./constants.js";
import { formatModel, modelKey } from "./models.js";
import { state } from "./state.js";
import type { ConfiguredModel } from "./types.js";

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return ["off", "minimal", "low", "medium", "high", "xhigh"].includes(String(value));
}

export function parseConfiguredModels(raw: unknown): ConfiguredModel[] {
  const source = raw && typeof raw === "object" && Array.isArray((raw as { try_models?: unknown }).try_models)
    ? (raw as { try_models: unknown[] }).try_models
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
    models.push({
      provider,
      modelname,
      reasoningEffort: isThinkingLevel(reasoning) ? reasoning : undefined,
    });
  }
  return models;
}

export function loadFallbackSettings(ctx: ExtensionContext): void {
  state.fallbackModels = [];

  try {
    const settingsManager = SettingsManager.create(ctx.cwd);
    const globalSettings = settingsManager.getGlobalSettings() as Record<string, unknown>;
    const projectSettings = settingsManager.getProjectSettings() as Record<string, unknown>;
    const globalConfig = globalSettings[SETTINGS_KEY];
    const projectConfig = projectSettings[SETTINGS_KEY];
    const config = {
      ...(globalConfig && typeof globalConfig === "object" && !Array.isArray(globalConfig) ? globalConfig : {}),
      ...(projectConfig && typeof projectConfig === "object" && !Array.isArray(projectConfig) ? projectConfig : {}),
    };
    const content = JSON.stringify(config);
    const shouldNotify = state.settingsSignature !== content;
    state.settingsSignature = content;

    const configured = parseConfiguredModels(config);
    if (configured.length === 0) return;

    const warnings: string[] = [];
    const seen = new Set<string>();

    for (const entry of configured) {
      const model = ctx.modelRegistry.find(entry.provider, entry.modelname);
      if (!model) {
        warnings.push(`missing ${entry.provider}/${entry.modelname}`);
        continue;
      }
      if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
        warnings.push(`no auth ${entry.provider}/${entry.modelname}`);
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
    const message = lines.length > 0
      ? `Loaded ${SETTINGS_KEY}.try_models:\n${lines.join("\n")}`
      : `Loaded ${SETTINGS_KEY}.try_models, but no usable fallback models were found.`;
    if (shouldNotify) {
      ctx.ui.notify(warnings.length > 0 ? `${message}\nSkipped: ${warnings.join(", ")}` : message, warnings.length > 0 ? "warning" : "info");
    }
  } catch (err) {
    ctx.ui.notify(`Could not load ${SETTINGS_KEY}.try_models: ${err instanceof Error ? err.message : String(err)}`, "warning");
  }
}
