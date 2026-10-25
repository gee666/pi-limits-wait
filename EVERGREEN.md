## Summary
- Keep provider failures recoverable through retries and optional ordered model fallback.
- Preserve runtime-owned authentication, target headers, hooks, and conversation continuity.
- Public integration uses extension lifecycle/provider events, session controls, UI, and telemetry.
- Unsupported interception uses `ModelRuntime.prototype.streamSimple` and `ExtensionRunner.prototype.createContext`.
- Main risks: Pi internal changes, cross-model credentials, stream commitment, reload ownership, and retry timing.

## Intent
Wait rather than abandon recoverable requests; respect explicit provider deadlines.
Prefer configured models in order, reclaim recovered models, and honor manual selections.
Never retry after substantive output or take over Pi's context-overflow recovery.
Keep retry summaries durable but outside model context; retain Anthropic OAuth identity while cleaning host prompts.
The master kill switch leaves only prompt cleaning enabled.

## Pi integration (public APIs)
`pi.on()` handles session/run/turn lifecycle, `model_select`, `before_provider_request`, and `cache_warming_decision`.
`pi.setModel()`, thinking-level controls, `ctx.modelRegistry`, and project trust support fallback selection/settings.
`pi.appendEntry()` stores retry metadata; `pi.events` emits versioned wait telemetry.
`ctx.ui` supports notifications, non-interactive status, and the TUI retry editor.
Provider response/payload callbacks and Pi's `isContextOverflow()` preserve native integration semantics.

## Internal Pi APIs
`src/stream.ts` patches `ModelRuntime.prototype.streamSimple` with a process-global, reload-owned trampoline.
Pi has no public failed-stream middleware that can own these retries and fallbacks.
`src/header-dispatch.ts` patches `ExtensionRunner.prototype.createContext`, maps registries to runners,
and calls `emitBeforeProviderHeaders` to dispatch hooks on freshly resolved fallback headers.
Exported classes do not make these interception points supported extension contracts.

## Weak points
One active extension/session runtime per process; concurrent SDK sessions are unsupported.
Fallback must discard source-bound secrets/options without dropping target hooks or native attribution.
Abort, committed output, user selection, probes, and reload race with pending attempts.
Explicit reset deadlines must prevent early probes; estimated limits permit silent probes.
Unknown errors deliberately retry broadly, while workspace-admin limits use the bounded retry policy.
OAuth prompt cleaning depends on Pi's exact identity/payload shape; cache-warming veto is last-override-wins.

## Tests
`npm run test:evergreen` runs unit tests, SDK integration, and the global-CLI evergreen e2e suite.
`npm test` includes strict TypeScript checking, runtime/HTTP retry and priority tests, and editor routing tests.
`src/__tests__/test-integration.ts` drives a real SDK session/extension runner with isolated dummy providers:
primary rate limit -> fallback unknown error -> retry success; asserts model commitment, one accurate summary,
no failed assistant turns, next-turn continuity, and exclusion of summary metadata from model context.
`npm run test:e2e:evergreen` uses `scripts/test-evergreen-e2e.mjs`, real global Pi print/JSON mode,
ignored stdin, local retry/kill-switch cases, and a live model with persisted-session checks.
The print-mode regression injects the Codex `WebSocket closed 1006 Connection ended` provider error
with native and unknown-error retries disabled, then verifies one retry, a successful exit, and durable retry metadata.
CLI selection is `EVERGREEN_PI_BIN` or `pi` on PATH; live model selection is `EVERGREEN_E2E_MODEL`.
Existing `npm run test:e2e` remains a separate optional RPC suite requiring piped stdin;
it covers broader transport hooks, tools, compaction, abort, replacement, reload, and fallback headers.
RPC is not run by evergreen because its protocol inherently requires stdin.
No lint task is configured. Test only the latest Pi release; live access is required, not silently skipped.

## Relevant changelog topics
Watch ModelRuntime streaming/auth/header composition, ExtensionRunner context/header dispatch, and reload lifecycle.
Watch provider callbacks/stream events, context-overflow recovery, OAuth identity/system updates, and cache warming.
Watch model selection/thinking levels, project trust, custom-entry persistence, and JSON/RPC UI protocols.
