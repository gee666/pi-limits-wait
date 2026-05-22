# Pi Limits Wait

[![npm](https://img.shields.io/npm/v/oira666_pi-limits-wait?style=flat-square&logo=npm&logoColor=white&label=npm&color=7c3aed)](https://www.npmjs.com/package/oira666_pi-limits-wait) [![node](https://img.shields.io/badge/node-%3E%3D18-7c3aed?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org)

Pi extension that keeps requests alive when a provider rate-limits you or returns `server_is_overloaded`.

## Install

```bash
pi install npm:oira666_pi-limits-wait
```

Restart Pi or run `/reload` after installing.

## What it does

- Works with all Pi model providers/APIs that use `streamSimple`.
- On rate-limit errors (`429`, `rate_limit`, `too many requests`, quota/reset messages), waits and retries in a loop.
- Uses provider retry timing when available (`retry-after`, `retry-after-ms`, `retry in ...`, reset messages).
- If no retry timing is available for a rate limit, waits 30 minutes before retrying.
- On `server_is_overloaded`, waits 5 minutes, then retries. If the provider is still overloaded after Pi's normal retries, it waits another 5 minutes and repeats.
- Shows a countdown in the Pi status/working line.
- Press Enter during the countdown to skip the wait and retry immediately.
- Optionally falls back to configured models when the current/default model is rate-limited.

## Optional fallback models

By default, if you do not configure fallback models, the extension behaves exactly as before: it waits for the current model's limit to reset and retries.

To enable automatic model fallback, add `oira666_pi-subagents.try_models` to Pi's normal `settings.json`.

Pi settings can be global or project-local:

| Location | Scope |
|----------|-------|
| `~/.pi/agent/settings.json` | Global, all projects |
| `.pi/settings.json` | Project-local |

Project settings override global settings. The extension reads these through Pi's `SettingsManager`, so normal Pi settings paths and `PI_CODING_AGENT_DIR` are respected.

Example:

```json
{
  "oira666_pi-subagents": {
    "try_models": [
      {
        "provider": "anthropic",
        "modelname": "claude-sonnet-4-5",
        "reasoning effort": "medium"
      },
      {
        "provider": "openai",
        "modelname": "gpt-5.1-codex"
      }
    ]
  }
}
```

Each `try_models` entry supports:

- `provider` — required. The Pi provider name, for example `anthropic`, `openai`, `google`, etc.
- `modelname` — required. The model id/name as Pi knows it.
- `reasoning effort` — optional. One of `off`, `minimal`, `low`, `medium`, `high`, `xhigh`. If omitted, Pi's current/default reasoning level is used.

Fallback behavior:

1. Pi starts with the normal default or user-selected model.
2. If that model is rate-limited, the extension tries models in this order:
   - the original default/user-selected model;
   - then every model from `oira666_pi-subagents.try_models`, top to bottom.
3. The first model that responds without a rate-limit becomes the active Pi model for the rest of the session/task.
4. If that model later becomes rate-limited too, the extension starts again from the same ordered list.
5. Rate-limit reset times are remembered only in memory, so known-limited models are skipped until their countdown expires. This memory is cleared when Pi restarts.

When the settings are loaded, the extension shows the full usable fallback model list. When models become rate-limited, it shows a live countdown for each limited model.

## License

MIT
