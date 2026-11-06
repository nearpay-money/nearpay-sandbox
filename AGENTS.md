# AGENTS.md — nearpay-sandbox

You are working in **nearpay-sandbox**, one of 27 NearPay repositories (`nearpay-brain/architecture/repositories.md`).
Scope: Deterministic simulator of the route provider and chains for test mode, local development and E2E (NEAR Intents has no testnet).

## Before changing anything

1. Read `../nearpay-brain/AGENTS.md`, then this repo's LLD (`../nearpay-brain/lld/sandbox.md`) — it is the implementation spec; do not make design decisions it already makes.
2. Contracts (requests, responses, events, errors) come from `@nearpay/spec`. If one must change, open a PR in `nearpay-spec` first; never hand-write contract types here.
3. Check your change against invariants INV-1…INV-9 in `nearpay-brain/product/requirements.md`.

## Rules for this repo

- Hexagonal layout: `src/domain` and `src/scenarios` are pure (no I/O); `src/app` holds use cases; `src/infra` adapts the DB; `src/api` maps spec routes to use cases.
- The sandbox is a simulator, not a money service: it owns no merchant objects and emits no domain events, so there are no transitions or outbox rows. Every change to a simulated execution happens in one transaction holding its row (`FOR UPDATE`).
- Test mode only: refuse any live-mode principal (INV-8). Never call a real chain or provider.
- Parity first: requests and responses use the same `@nearpay-internal/spec` 1Click schemas as the rails adapter; signatures use the 1Click construction; Verifier rejections use mainnet's messages.
- Money is bigint base units (`@nearpay-internal/money` rationals). No floats in amounts.
- Every scenario and rule has a test; keep ≥ 90% branch coverage on the pure code.

## Never

- Import source code from another NearPay repo (depend on published packages/images only).
- Read or write another service's database.
- Add design documents here — update `nearpay-brain` and link to it.
- Commit secrets, private keys or real customer data.
- Merge changes to paths listed in `.github/CODEOWNERS` without the required human review.
