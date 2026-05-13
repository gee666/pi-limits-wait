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

## License

MIT
