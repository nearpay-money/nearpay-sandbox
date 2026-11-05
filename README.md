# nearpay-sandbox

> Deterministic simulator of the route provider and chains for test mode, local development and E2E (NEAR Intents has no testnet).

| | |
|---|---|
| Group | Services |
| Kind | service |
| Ships as | image: ghcr.io/nearpay-money/sandbox · internal only (test-mode rail) |
| Owns | Simulated quotes, executions, chain evidence |
| Depends on (published artifacts only) | spec, kit |
| Roadmap phase | P0 Foundations |

## Documentation

This repo stays surgical: design docs live in [`nearpay-brain`](../nearpay-brain/README.md), not here.

- `nearpay-brain/architecture/hld.md` — system design
- `nearpay-brain/architecture/repositories.md` — repo topology and dependency rules
- `nearpay-brain/decisions/ADR-0007-test-mode-sandbox.md`
- `nearpay-brain/architecture/api-conventions.md#8-test-mode`

## Layout

```
nearpay-sandbox/
├── src/
│   ├── api/
│   ├── scenarios/
│   ├── simulated-chains/
│   └── test-helpers/
├── test/
│   ├── scenario/
│   └── unit/
└── .github/
    └── workflows/
```

## Status

Scaffold only. Implementation starts in phase **P0 Foundations** (`nearpay-brain/roadmap/roadmap.md`).
