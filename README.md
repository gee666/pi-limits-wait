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
- On transient network/transport failures — including undici idle-timeout aborts (`UND_ERR_HEADERS_TIMEOUT` / `UND_ERR_BODY_TIMEOUT`), `fetch failed`, `terminated`, `ECONNRESET`, `ETIMEDOUT`, etc. — treats the error as retryable with a short backoff (default 15s, or the provider's `retry-after`) instead of giving up. This prevents a stalled streaming request from turning into a silent hang.
- For any other (unclassified) non-retryable error, retries the same model a few times (default 3) before falling back / freezing it, so a one-off hiccup does not immediately sideline a model.
- Reports retry/fallback waits in chat notifications without adding persistent TUI status lines.
- Press Enter during a retry wait to skip the wait and retry immediately.
- Optionally falls back to configured models when the current/default model is rate-limited.

## Optional fallback models

By default, if you do not configure fallback models, the extension behaves exactly as before: it waits for the current model's limit to reset and retries.

To enable automatic model fallback, add `fallback-models` to a `limits-wait.json` file.

The extension reads these files in order; later files override earlier ones:

| Location | Scope |
|----------|-------|
| `~/.config/.pi/limits-wait.json` | Global defaults |
| `<Pi agent dir>/limits-wait.json` (for example `~/.pi/agent/limits-wait.json`, or `PI_CODING_AGENT_DIR/limits-wait.json`) | Pi agent directory |
| `.limits-wait.json` | Project root override |
| `.pi/limits-wait.json` | Pi project override |

Example:

```json
{
  "fallback-models": [
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
```

Each `fallback-models` entry supports:

- `provider` — required. The Pi provider name, for example `anthropic`, `openai`, `google`, etc.
- `modelname` — required. The model id/name as Pi knows it.
- `reasoning effort` — optional. One of `off`, `minimal`, `low`, `medium`, `high`, `xhigh`. If omitted, Pi's current/default reasoning level is used.

Fallback behavior:

1. Pi starts with the normal default or user-selected model.
2. If that model is rate-limited, the extension tries models in this order:
   - the original default/user-selected model;
   - then every model from `fallback-models`, top to bottom.
3. The first model that responds without a rate-limit becomes the active Pi model for the rest of the session/task.
4. If that model later becomes rate-limited too, the extension starts again from the same ordered list.
5. Rate-limit reset times are remembered only in memory, so known-limited models are skipped until their countdown expires. This memory is cleared when Pi restarts.

When the settings are loaded, the extension shows the full usable fallback model list. When models become rate-limited, it reports the wait in chat notifications.

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PI_LIMITS_WAIT_FREEZING_ENABLED` | `true` | When a model keeps failing with a non-retryable error, it is normally "frozen" for 1 hour and skipped in favour of other configured models. Set this to `false` (also accepts `0`, `no`, `off`) to disable freezing entirely: the extension will instead try each configured candidate once (after the bounded retries) and then surface the error, never blocking on a long "model-frozen" wait. Useful for non-interactive / subagent runs where no one can press Enter to skip. |

## License

MIT
