# Memory and handoff

Agent memory has two ways to go wrong: the agent forgets, or it trusts something the code has moved past. MAP-IT-ALL addresses the second one directly.

## Notes

A note is a small JSON file in `.map-it-all/memory/notes/`:

```json
{
  "id": "health-route-stays-above-a1b2c",
  "title": "Health route stays above the routers",
  "body": "Load balancers hit /health before auth is mounted.",
  "kind": "decision",
  "tags": ["express"],
  "anchors": [{ "path": "server/app.ts", "hash": "9f2c1d0e7a4b3c88" }],
  "head": "abc1234",
  "created": "...", "updated": "..."
}
```

- **kind:** `fact`, `decision`, `gotcha`, `todo`, `preference`.
- **anchors:** existing files the note is about. The hash is a SHA-1 of the file text with CRLF normalised, so line-ending churn is not staleness. Anchors must exist when the note is saved.
- **Limits:** body up to 2,000 characters, title up to 120. Long memory costs tokens every time it is recalled; link a file instead.
- **Same title replaces** the note rather than duplicating it.

## Staleness

`recall` re-hashes every anchor against the working tree:

| Status | Meaning |
| --- | --- |
| `fresh` | every anchored file is unchanged |
| `stale` | an anchored file changed: verify before relying on the note |
| `orphaned` | an anchored file no longer exists |

`confirm` re-hashes after the agent verified the note is still true. A note without anchors can never be flagged, and `remember` says so.

## Handoff

`handoff save` stores a summary, next steps, and the files touched (hashed). `handoff read`, and the `brief`, show it with warnings: the branch is different now, N commits landed since, these files changed since.

## Where it lives

By default under `.map-it-all/memory/` (gitignored, per machine). To share notes with a team, set `"memoryDir": "docs/agent-memory"` in `map-it-all.config.json` and commit it. Hashes are content-based, so they stay valid across machines.

## Why not a vector database

For project memory the questions are "what did we decide about this file?" and "is that still true?". Both are answered by file anchors and a text search, with nothing to host, no embeddings to pay for, and every note readable by a human. If you outgrow that, MAP-IT-ALL's notes are plain JSON and easy to export.
