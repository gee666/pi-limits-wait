# Repository instructions

## Repository synchronization

- Before starting any work, pull the latest changes from `origin` with `git pull --ff-only`. Preserve local edits; stop and resolve safely if the pull is blocked.
- After each completed, validated piece of work, commit your changes and push to `origin` immediately. Work happens on multiple machines; do not leave finished work unsynchronized.

## Release checks

- Test only against the latest npm Pi release. `npm test` first installs this repository's direct Pi development dependencies at `@latest` with `--save-dev --ignore-scripts`, then runs the existing typecheck. Keep installation scripts disabled to avoid lifecycle recursion. Do not add an older-version test matrix.
- Before every release, run `npm test` and all other available checks. Confirm the installed Pi version and update the README line `Tested against Pi <actual version>.` only after checks pass. Never claim an untested version.
- Commit the updated dependency manifest and lockfile. Keep Pi peer dependency lower bounds at the tested latest release, currently `>=1.4.0`; do not use wildcard ranges or claim older, untested support.
- Run `npm run check` for strict TypeScript checking, any configured lint command, and the full test suite. Run the package dry-run check too. Report missing checks or failures; do not bypass them.

## Code quality

- Keep changes scoped to the task. Do not refactor unrelated code or split existing long files solely to apply these rules.
- Remove dead code, unused imports, and unused dependencies in changed code. Avoid speculative abstractions and duplicated logic; use the simplest implementation that meets the requirement.
- Keep retry orchestration, error classification, model selection, settings, and UI/telemetry in their existing modules. Follow the repository's TypeScript/Node.js conventions and keep dependencies flowing across those boundaries deliberately.
- Fix root causes rather than hiding failures or patching dependency internals. Keep configuration explicit. Never hardcode or commit secrets, credentials, or private runtime data.
- Keep TypeScript strict. Validate external data at runtime, including settings, files, provider responses, and IPC messages. Use `unknown` and narrowing instead of `any`, unsafe type assertions, non-null assertions, or type/lint suppressions.
- Write focused functions and cohesive files. Split files before they reach 350 lines unless keeping them together has a specific cohesion benefit; explain that exception in the change.
- Keep documentation short and accurate. Apply the `unslop` and `write-prompts` skills when available for prose and prompt edits. Document behavior and configuration, not unsupported promises.
- Add regression tests for behavior changes. Run typechecking, available lint checks, and tests before committing. This repository currently has no lint command; do not report lint as passed when it is absent.
- Match validation to the changed resource. Typechecking does not execute README snippets or prove that a theme loads or renders correctly. For snippet or theme changes, run the relevant example, loader/schema check, or rendering check when available and state exactly what ran. Report any manual or live-service validation that was not performed.
- Put temporary files and test scratch data under this repository's ignored `tmp/` directory. Give every shell command a timeout.
