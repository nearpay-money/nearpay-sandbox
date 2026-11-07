# nearpay-sandbox

> Deterministic simulator of the route provider and chains for test mode, local development and E2E (NEAR Intents has no testnet).

|                                       |                                                                       |
| ------------------------------------- | --------------------------------------------------------------------- |
| Group                                 | Services                                                              |
| Kind                                  | service                                                               |
| Ships as                              | image: ghcr.io/nearpay-money/sandbox · internal only (test-mode rail) |
| Owns                                  | Simulated quotes, executions, chain evidence                          |
| Depends on (published artifacts only) | spec, kit                                                             |
| First built in                        | Stage 1 (step 1.2)                                                    |

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
│   ├── main.ts               process entry: `api` | `migrate` | `healthcheck`
│   ├── config.ts             NP_* configuration (secrets from files)
│   ├── api/                  spec route bindings (every route: service token with `sandbox.use`, test mode only)
│   ├── app/                  use cases: quotes, executions (deposits, timelines, status, materializer), Explorer mirror, service wiring
│   ├── domain/               pure: fixed token registry, quote amounts (exact rationals), Explorer rows
│   ├── scenarios/            pure: scenario keys 00–07, timelines, manual-advance plans, scenario groups
│   ├── simulated-chains/     deterministic addresses and tx hashes, settlement payouts, chain txs, Verifier
│   ├── test-helpers/         simulated deposits (`/sim/deposits`) and manual stepping (`/sim/advance`)
│   └── infra/db/             Kysely schema, migrations path
├── migrations/               plain SQL (kit tables first, then 0001_sandbox.sql, 0002_sandbox_stage2.sql)
├── test/
│   ├── unit/ property/       pure code (Vitest, fast-check)
│   ├── integration/          1Click mirror and Verifier over HTTP on real Postgres (Testcontainers)
│   ├── scenario/             scenarios 00–07 end to end, manual control, refund legs
│   ├── contract/             spec route coverage, 1Click shape parity against recorded mainnet bodies
│   └── fixtures/             recorded 1Click responses
└── Dockerfile                distroless Node 22 image, `node dist/main.js <process>`
```

## Commands

| Command                                                                                                    | What it does                                                                                                                                        |
| ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install`                                                                                             | Install (Node 22, pnpm 9); `@nearpay/*` and `@nearpay-internal/*` come from the local registry (`.npmrc`, `nearpay-deploy/scripts/up.sh` starts it) |
| `pnpm test`                                                                                                | Unit and property tests                                                                                                                             |
| `pnpm test:integration`                                                                                    | Integration, scenario and contract tests on real Postgres (Testcontainers; needs Docker)                                                            |
| `pnpm verify`                                                                                              | typecheck + lint + unit tests with the coverage gate + integration tests + build                                                                    |
| `docker build --network host --build-arg NP_REGISTRY_URL=http://127.0.0.1:4873 -t nearpay/sandbox:local .` | Image (what `up.sh` runs)                                                                                                                           |

## Configuration

| Variable                      | Meaning                                                                                          |
| ----------------------------- | ------------------------------------------------------------------------------------------------ |
| `NP_DB_URL_FILE`              | Database URL (app role for `api`, migrator role for `migrate`)                                   |
| `NP_JWKS_URL`                 | identity's JWKS (verifies service tokens)                                                        |
| `NP_SANDBOX_SIGNING_KEY_FILE` | Ed25519 PKCS#8 PEM that signs quotes; rails and sentinel verify with `NP_SANDBOX_SIGNING_PUBKEY` |
| `NP_SANDBOX_TIME_SCALE`       | Multiplies every timeline offset (default 1.0; the testbed may set 0.1)                          |
| `NP_SANDBOX_TICK_MS`          | How often due timeline steps are applied (default 200)                                           |

## Behaviour

- **1Click mirror** (`/v0/tokens`, `/v0/quote`, `/v0/status`, `/v0/deposit/submit`): same schemas as the rails 1Click adapter, served in **live 1Click's shape** (spec 0.2.0; parity-tested against a recorded mainnet status body): unset optionals as `null` (`swapDetails.amountOut` before settlement, `appFees[].limitOrderId`, `virtualChainRecipient`), `refundedAmount` `"0"` until a refund, and `GET /v0/status` nests the quote response without `correlationId` and its request without `quoteWaitingTimeMs`. Quotes are signed with the 1Click construction (`quoteHash` of the 1Click SDK, Ed25519), so `verifyQuoteSignature(quote, sandboxKey)` verifies them. Rails sets `scenario_amount` (the pricing amount) to pick the scenario, and since Stage 2 `scenario_group` (`pi_…` / `re_…`) and `scenario_kind` (`payment` | `refund`); none of them are echoed.
- **Scenarios** (last two digits of `scenario_amount`): `00` success in ~5 s · `01` after 120 s · `02` underpaid → refunded at the deadline · `03` overpaid → success + excess refund · `04` failed after processing · `05` short by one base unit · `06` duplicate settlement: paying a newer attempt also settles the older open ones of the same payment; on refund legs a deposit to one leg settles every other open leg of the same refund, even an expired one (payments records a `duplicate` leg) · `07` success 5 min after the deadline. The outcome follows the deposit amount like 1Click (below `minAmountIn` → refunded, above `amountIn` → excess refunded, after the deadline → refunded).
- **Refund legs** (Stage 2): `EXACT_INPUT` (the merchant sends exactly the refund; the payer gets it less 20 bps) and `EXACT_OUTPUT` quotes without app fee; an `INTENTS`-deposit leg is funded by a Verifier transfer into its deposit address (a merchant-signed `execute` relayed by agentpay, or `/sim/intents/transfers`), which records the deposit and starts the scenario.
- **Simulated chains**: settlements to Intents accounts credit the simulated Verifier ledger and emit `mt_transfer` (the rails sandbox indexer attributes them), so a merchant's settled test payments are its simulated Intents balance for refunds; chain settlements are simulated transactions read by `/sim/chains/{chain}/tx/{hash}`.
- **Simulated Verifier** (`/sim/intents/*`): real NEP-413 / ERC-191 / raw ed25519 signature checks, nonces, balances, mainnet rejection messages; batches are atomic. Named accounts register the first key that signs for them. `POST /sim/intents/transfers` (Stage 2) executes an unsigned transfer (minting any shortfall first) with the same events as a signed one — payments' refund test helper.
- **Explorer mirror** (Stage 2, `GET /api/v0/transactions`): the sandbox's quotes as Explorer rows, newest first, with the Explorer's filters (`referral`, `statuses`, time bounds, `search`, `depositMemo`) and cursor paging; `KNOWN_DEPOSIT_TX` reads `PROCESSING`, amounts read `0` until final. Rails runs its Explorer feed against it in test mode.
- **Test mode only**: a principal in live mode gets `403 livemode_forbidden` (INV-8).

## Status

Stage 1 (step 1.2) implemented: every sandbox route of `@nearpay-internal/spec` 0.1.1, scenarios 00–07, manual control, simulated chains and Verifier. Stage 2 (step 2.2, spec 0.2.0): live 1Click body shape, refund legs (`scenario_group` / `scenario_kind`, scenario `06` for refunds, `INTENTS` deposits funded by Verifier transfers), `POST /sim/intents/transfers` and the Explorer mirror (sandbox LLD v1.4).

## Built with

TypeScript 5, Node 22, `@nearpay-internal/*` kit (service, db, chains, intents, money), `@defuse-protocol/one-click-sdk-typescript` (quote hash), `@noble/hashes`, `@scure/base` (bech32), `bs58`, Kysely + pg; tests with Vitest, fast-check and Testcontainers. Code and documentation are written with AI assistance (Claude) under human direction and review.
