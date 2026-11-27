# Model fingerprint identifier

A local-first model-route observability plugin for DeepSeek Harness. It compares protocol shapes and behavior statistics across sessions, shows per-turn evidence, and flags routing drift.

![Model fingerprint panel](docs/preview.svg)

Fingerprints are **evidence**, not proof of model identity. This plugin does not claim to identify a black-box model from text alone.

## What it does

- Groups model responses by wire protocol, adapter, response-id shape, usage fields, and behavior statistics.
- Shows a per-turn rail card with the current fingerprint and verdict.
- Compares routes for behavioral equivalence and compares routes with configured official baselines.
- Detects session-level behavior changes and route/fingerprint transitions.
- Optional: with a configured official watermark detector, a turn shows provenance evidence only when a watermark is detected (off by default; never part of the fingerprint).
- Keeps prompt and response text out of its local state.

## Install

Install from npm:

```powershell
dsh plugin --profile desktop add dsh-plugin-model-fingerprint@0.2.3
```

Or install a local checkout:

```powershell
git clone https://github.com/Darkhe55/dsh-plugin-models-fingerprint.git
dsh plugin --profile desktop add "C:\path\to\dsh-plugin-models-fingerprint"
```

Restart DSH after installation or upgrade.

## Quick start

1. Open a conversation with at least one completed model response.
2. Enable **Show fingerprint cards beside messages** above the composer.
3. Open **Panel** to inspect turns, fingerprint families, route equivalence, and official similarity.
4. Configure an official baseline only when you have explicit provider/model evidence.
5. Use **Drift diagnostics** to review session-level changes; treat them as exploratory signals.

## Features

| Area | What you get |
|---|---|
| Per-turn rail | Fingerprint, protocol state, model name, and verdict |
| Fingerprint families | Protocol shape, response-id shape, tool/usage fields |
| Route equivalence | Behavior distance between routes and sessions |
| Official baselines | Explicit evidence levels and stale-safe calibration |
| Drift diagnostics | Session-level change points and route transitions |
| Local persistence | Append-only journal, crash recovery, offline compaction |
| Privacy | No prompt or response body stored in plugin state |

## Boundaries

- `fp_...` identifies a transport/protocol fingerprint, not a model weight set.
- Official identity requires explicit evidence and still remains an attribution, not cryptographic proof.
- Passive behavior cannot identify MoE experts or guarantee a provider's routing.
- FPR and confidence results can be “insufficient”; the plugin must not turn them into a positive claim.
- A watermark is provenance evidence only: it is shown when detected, its absence proves nothing, and it never feeds the fingerprint or verdict.
- No provider API is called unless you explicitly run a probe.

## Data and privacy

Plugin state lives under:

```text
%USERPROFILE%\.dsh\model-fingerprint
```

It stores protocol shapes, behavior summaries, hashes, session IDs, timestamps, labels, baselines, and calibration metadata. It does **not** store prompt text or assistant response text.

Before a major upgrade, copy the state directory. Do not delete `state.json.zst` or `journal-v3` while diagnosing persistence.

## Compatibility

- DSH `>=0.2.2-rc.1 <0.3.0`
- Node.js 24 runtime used by current DSH desktop builds
- Web client and local dashboard

## Development

```powershell
npm install
npm run build
npm test
npm run check
```

Useful offline checks:

```powershell
npm pack --dry-run
npm run bench:persistence
npm run benchmark:minimax
npm run benchmark:official
```

## Documentation

- [Full Chinese reference](docs/REFERENCE.zh.md)
- [中文 README](README.zh.md)
- [Plugin details](docs/DETAIL.md)
- [Persistence and operations](docs/REFERENCE.zh.md#补算与存盘)

## License

MIT
