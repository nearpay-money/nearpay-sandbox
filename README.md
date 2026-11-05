# nearpay-sandbox

> Deterministic simulator of the route provider and chains for test mode, local development and E2E (NEAR Intents has no testnet).

| | |
|---|---|
| Group | Services |
| Kind | service |
| Ships as | image: ghcr.io/nearpay-money/sandbox · internal only (test-mode rail) |
| Owns | Simulated quotes, executions, chain evidence |
| Depends on (published artifacts only) | spec, kit |
| First built in | Stage 1 (step 1.2) |

## Documentation

This repo stays surgical: design docs live in [`nearpay-brain`](../nearpay-brain/README.md), not here.

- `nearpay-brain/lld/sandbox.md` — **low-level design (dev-ready; implement from this)**
- `nearpay-brain/lld/audits/sandbox.md` — audit findings already folded into the LLD
- `nearpay-brain/roadmap/development-plan.md` — stage and step this repo is built in
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

Scaffold only. Implementation starts in **Stage 1 (step 1.2)** (`nearpay-brain/roadmap/development-plan.md`).

## Built with

Libraries are listed here as they are added (hackathon rule Q-005). Code and documentation are written with AI assistance (Claude) under human direction and review.
