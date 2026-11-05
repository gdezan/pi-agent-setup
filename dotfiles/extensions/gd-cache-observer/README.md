# pi-cache-observer

A conservative prompt-cache observer for pi.

## What it does

- Reads normalized assistant usage from `message_end`.
- Calculates prompt tokens as `input + cacheRead + cacheWrite` and reports a session hit rate.
- Classifies turns as `unknown`, `unsupported`, `cache-write`, `cache-hit`, `partial-hit`, or
  `miss`.
- Alerts only for meaningful zero-read misses after prior cache activity and a 1,024-token floor.
- Resets the comparison baseline after model changes, compaction, tree navigation, and manual reset.
- Persists only redacted provider/model aggregates for 30 days, bounded to 1 MB.
- Adds a peer section to the shared `pi-footer` registry without replacing the footer.

## Commands

- `/cache` — current turn, session totals, baseline, and last reason.
- `/cache doctor` — reporting, trust/config, allowlist, optimizer, and storage diagnostics.
- `/cache optimize preview` — structural preview only; never prints prompts or payloads.
- `/cache reset` — reset the current-session baseline and alert deduplication.
- `/cache clear` — separately confirmed deletion of persisted aggregates.

## Opt-in optimizer

The optimizer reads only a trusted project's `.pi/prompt-cache.json`:

```json
{
  "optimizer": {
    "mode": "preview",
    "entries": [
      {
        "provider": "<exact-provider>",
        "model": "<exact-model>",
        "promptCacheKey": "<explicit-stable-key>"
      }
    ]
  }
}
```

Preview mode is the default whenever optimizer configuration is present. `live` mode is explicit and
only adds `prompt_cache_key` to a verified OpenAI-compatible chat payload for an exact
provider/model allowlist match. It does not rewrite prompts, add headers, warm caches, or send
retention hints. Unsafe, malformed, unsupported, and failed mutations preserve the original payload.

Do not add a live entry until a real serialized payload fixture for the active provider has been
inspected. OpenAI-shaped proxies are not interchangeable.

Aggregate storage is global at `$PI_CODING_AGENT_DIR/prompt-cache-stats.json` (default
`~/.pi/agent/prompt-cache-stats.json`). It contains no prompts, payloads, headers, base URLs, or
session IDs.
