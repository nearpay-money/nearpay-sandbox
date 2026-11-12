# nearpay-sandbox

Deterministic simulator of the route provider (1Click), the NEAR Intents Verifier, the chains and the subscription vault. It is what NearPay's test mode, local development and the end-to-end tests run on, because NEAR Intents has no testnet.

Part of [NearPay](https://github.com/nearpay-money/nearpay) — start there for the live demo, the architecture diagram and the full "do X, see Y" walkthrough.

- **Where it sits:** internal only. In test mode rails uses it as its route provider, Explorer feed and chain source; agentpay submits signed test payloads to its simulated Verifier; billing's keeper talks to its vault stand-in over a NEAR JSON-RPC subset; sentinel re-reads test quotes from it; payments' test helpers simulate deposits through it. It calls no other service and refuses live-mode principals (`403 livemode_forbidden`).
- **Status:** NearPay runs on NEAR mainnet as a closed beta (https://nearpay.money); this service backs the test mode of that deployment. Its vault stand-in is also the only vault in use today: the real subscription-vault contract is not deployed on mainnet yet (planned account `v1.nearpay-money.near`).

|                                       |                                                                       |
| ------------------------------------- | --------------------------------------------------------------------- |
| Group                                 | Services                                                              |
| Kind                                  | service                                                               |
| Ships as                              | image: ghcr.io/nearpay-money/sandbox · internal only (test-mode rail) |
| Owns                                  | Simulated quotes, executions, chain evidence                          |
| Depends on (published artifacts only) | spec, kit                                                             |
| First built in                        | Stage 1 (step 1.2)                                                    |

## Documentation

Design docs live in [`nearpay-brain`](https://github.com/nearpay-money/nearpay-brain), not here.

- [`lld/sandbox.md`](https://github.com/nearpay-money/nearpay-brain/blob/main/lld/sandbox.md) — low-level design this repo is implemented from
- [`lld/audits/sandbox.md`](https://github.com/nearpay-money/nearpay-brain/blob/main/lld/audits/sandbox.md) — audit findings already folded into the LLD
- [`roadmap/development-plan.md`](https://github.com/nearpay-money/nearpay-brain/blob/main/roadmap/development-plan.md) — stage and step this repo is built in
- [`architecture/hld.md`](https://github.com/nearpay-money/nearpay-brain/blob/main/architecture/hld.md) — system design
- [`architecture/repositories.md`](https://github.com/nearpay-money/nearpay-brain/blob/main/architecture/repositories.md) — repo topology and dependency rules
- [`decisions/ADR-0007-test-mode-sandbox.md`](https://github.com/nearpay-money/nearpay-brain/blob/main/decisions/ADR-0007-test-mode-sandbox.md)
- [`architecture/api-conventions.md#8-test-mode`](https://github.com/nearpay-money/nearpay-brain/blob/main/architecture/api-conventions.md#8-test-mode)

## Layout

```
nearpay-sandbox/
├── src/
│   ├── main.ts               process entry: `api` | `migrate` | `healthcheck`
│   ├── config.ts             NP_* configuration (secrets from files)
│   ├── api/                  spec route bindings (every route: service token with `sandbox.use`, test mode only)
│   ├── app/                  use cases: quotes, executions (deposits, timelines, status, materializer), Explorer mirror, service wiring
│   ├── domain/               pure: fixed token registry, quote amounts (exact rationals), Explorer rows, chain fields
│   │   └── vault/            pure: subscription-vault stand-in (contract port, serde-faithful JSON, receipt runtime, borsh txs)
│   ├── scenarios/            pure: scenario keys 00–09, timelines, manual-advance plans, scenario groups
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

## Verify this repo

Needs Node 22 (`.nvmrc`) and pnpm 9. `.npmrc` points the `@nearpay-money` and `@nearpay-internal` scopes at a local package registry, so start that first.

1. Start the local registry (no Docker, Node 22 only):
   `git clone https://github.com/nearpay-money/nearpay-deploy ../nearpay-deploy && ../nearpay-deploy/scripts/registry.sh start`
   → `curl http://127.0.0.1:4873/-/ping` answers `{}`.
2. `pnpm install --frozen-lockfile` → ends with `Done in …`, no registry errors.
3. `pnpm test` (unit and property tests: scenarios, quote signing, the simulated Verifier and chains, the vault port against the spec's `test-vectors/vault.json`; no Docker) → `Test Files  16 passed (16)`, `Tests  195 passed (195)`.
4. `pnpm verify` (the full gate: typecheck, lint, unit tests with the coverage gate of ≥ 90 % branches on the pure code, integration tests, build) → exits 0. The integration, scenario and contract tests run on a real Postgres started by Testcontainers, so this step needs a running Docker daemon; steps 1–3 do not.
5. Optional, with Docker: the `docker build` line in the table below produces `nearpay/sandbox:local`, the image the rails, sentinel and agentpay integration tests start.

## Commands

| Command                                                                                                    | What it does                                                                                      |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`                                                                           | Install (Node 22, pnpm 9); NearPay packages come from the local registry (see "Verify this repo") |
| `pnpm test`                                                                                                | Unit and property tests                                                                           |
| `pnpm test:integration`                                                                                    | Integration, scenario and contract tests on real Postgres (Testcontainers; needs Docker)          |
| `pnpm verify`                                                                                              | typecheck + lint + unit tests with the coverage gate + integration tests + build                  |
| `docker build --network host --build-arg NP_REGISTRY_URL=http://127.0.0.1:4873 -t nearpay/sandbox:local .` | Image (what nearpay-deploy's `scripts/up.sh` runs)                                                |

## Configuration

| Variable                        | Meaning                                                                                          |
| ------------------------------- | ------------------------------------------------------------------------------------------------ |
| `NP_DB_URL_FILE`                | Database URL (app role for `api`, migrator role for `migrate`)                                   |
| `NP_JWKS_URL`                   | identity's JWKS (verifies service tokens)                                                        |
| `NP_SANDBOX_SIGNING_KEY_FILE`   | Ed25519 PKCS#8 PEM that signs quotes; rails and sentinel verify with `NP_SANDBOX_SIGNING_PUBKEY` |
| `NP_SANDBOX_TIME_SCALE`         | Multiplies every timeline offset (default 1.0; the testbed may set 0.1)                          |
| `NP_SANDBOX_TICK_MS`            | How often due timeline steps are applied (default 200)                                           |
| `NP_SANDBOX_VAULT_ACCOUNT`      | Account the vault stand-in plays (default `vault.sandbox.near`, billing's test-mode vault)       |
| `NP_SANDBOX_VAULT_FEE_RECEIVER` | Treasury of the stand-in's fee legs (default `treasury.sandbox.near`)                            |
| `NP_SANDBOX_VAULT_CAPS`         | JSON `[{token, cap, mandate_cap}]` (default per token 10^15 / 10^12 base units)                  |

## Behaviour

- **1Click mirror** (`/v0/tokens`, `/v0/quote`, `/v0/status`, `/v0/deposit/submit`): same schemas as the rails 1Click adapter, served in **live 1Click's shape** (spec 0.2.0; parity-tested against a recorded mainnet status body): unset optionals as `null` (`swapDetails.amountOut` before settlement, `appFees[].limitOrderId`, `virtualChainRecipient`), `refundedAmount` `"0"` until a refund, and `GET /v0/status` nests the quote response without `correlationId` and its request without `quoteWaitingTimeMs`. Quotes are signed with the 1Click construction (`quoteHash` of the 1Click SDK, Ed25519), so `verifyQuoteSignature(quote, sandboxKey)` verifies them. Rails sets `scenario_amount` (the pricing amount) to pick the scenario, and since Stage 2 `scenario_group` (`pi_…` / `re_…`) and `scenario_kind` (`payment` | `refund`); none of them are echoed.
- **Scenarios** (last two digits of `scenario_amount`): `00` success in ~5 s · `01` after 120 s · `02` underpaid → refunded at the deadline · `03` overpaid → success + excess refund · `04` failed after processing · `05` short by one base unit · `06` duplicate settlement: paying a newer attempt also settles the older open ones of the same payment; on refund legs a deposit to one leg settles every other open leg of the same refund, even an expired one (payments records a `duplicate` leg) · `07` success 5 min after the deadline · `08` (Stage 4) the destination tx is not final for 60 s (Bitcoin: 0 confirmations) · `09` (Stage 4) Solana: a failed signature precedes the payout; Bitcoin: the payout is split over two outputs (vout 0 and 2, solver change vout 1); other chains like `00`. The outcome follows the deposit amount like 1Click (below `minAmountIn` → refunded, above `amountIn` → excess refunded, after the deadline → refunded).
- **Refund legs** (Stage 2): `EXACT_INPUT` (the merchant sends exactly the refund; the payer gets it less 20 bps) and `EXACT_OUTPUT` quotes without app fee; an `INTENTS`-deposit leg is funded by a Verifier transfer into its deposit address (a merchant-signed `execute` relayed by agentpay, or `/sim/intents/transfers`), which records the deposit and starts the scenario.
- **Simulated chains**: settlements to Intents accounts credit the simulated Verifier ledger and emit `mt_transfer` (the rails sandbox indexer attributes them), so a merchant's settled test payments are its simulated Intents balance for refunds; chain settlements are simulated transactions read by `/sim/chains/{chain}/tx/{hash}`. Stage 4 (spec 0.4.0): Solana transactions carry a slot (`block_ref` 380000000 + n) and SPL transfers the recipient's associated token account (`token_account`); Bitcoin transactions a height (900000 + n), output indexes (`vout`) and `confirmations` (1 when recorded, +1 per 30 s × time scale, max 6). Solana USDT is in the registry.
- **Subscription-vault stand-in** (Stage 4, OQ-T-03): one vault account served over a NEAR JSON-RPC subset (`POST /sim/near-rpc`: `block`, `query` views and access keys, `send_tx` / `broadcast_tx_commit` with borsh decoding and ed25519 verification, `tx`) plus unsigned payer helpers (`/sim/vault/ft_transfer_call`, `/sim/vault/call`) and per-mandate clocks (`/sim/vault/advance`). The contract's rules are ported from `subscription-vault/src` (check orders, `ERR_*` panics, rejection lines, refunds, storage, views), contract-tested against the spec's `test-vectors/vault.json`; receipts run synchronously with mainnet outcome shapes and every receipt line reaches `/sim/intents/events` with its receipt context. Scenarios by the last two digits of `amount_per_period`: `91` merchant leg fails · `92` fee leg fails · `93` first refund fails · `94` partial delivery `floor(share/2)`.
- **Indexer feed order**: `/sim/intents/events` positions are assigned at commit (migration 0003), so a cursor never skips a line that committed late.
- **Simulated Verifier** (`/sim/intents/*`): real NEP-413 / ERC-191 / raw ed25519 signature checks, nonces, balances, mainnet rejection messages; batches are atomic. Named accounts register the first key that signs for them. `POST /sim/intents/transfers` (Stage 2) executes an unsigned transfer (minting any shortfall first) with the same events as a signed one — payments' refund test helper.
- **Explorer mirror** (Stage 2, `GET /api/v0/transactions`): the sandbox's quotes as Explorer rows, newest first, with the Explorer's filters (`referral`, `statuses`, time bounds, `search`, `depositMemo`) and cursor paging; `KNOWN_DEPOSIT_TX` reads `PROCESSING`, amounts read `0` until final. Rails runs its Explorer feed against it in test mode.
- **Test mode only**: a principal in live mode gets `403 livemode_forbidden` (INV-8).

## Status

Stage 1 (step 1.2) implemented: every sandbox route of `@nearpay-internal/spec` 0.1.1, scenarios 00–07, manual control, simulated chains and Verifier. Stage 2 (step 2.2, spec 0.2.0): live 1Click body shape, refund legs (`scenario_group` / `scenario_kind`, scenario `06` for refunds, `INTENTS` deposits funded by Verifier transfers), `POST /sim/intents/transfers` and the Explorer mirror (sandbox LLD v1.4). Stage 4 (step 4.2, spec 0.4.0): the subscription-vault stand-in and the Solana/Bitcoin simulation (sandbox LLD v1.7).

Since then: `.omdep.near` tokens in the test-mode registry (USDT on BNB Smart Chain, USD1 on Solana) and kit 0.6.0 (materializer liveness heartbeat). Current pins (`package.json`): `@nearpay-money/spec` 0.5.2, kit packages 0.6.0.

## Built with

- Runtime: TypeScript 5 on Node 22; `@nearpay-internal/*` kit (service, db, auth, http, chains, intents, money, ids) with Fastify and Kysely + pg underneath; `@defuse-protocol/one-click-sdk-typescript` (quote hash), `@noble/curves`, `@noble/hashes`, `@scure/base` (bech32), `bs58`, `zod`.
- Tests and tooling: Vitest, fast-check, Testcontainers (through `@nearpay-internal/testing`), `@near-js/*` (test only: borsh transactions for the vault stand-in), Biome.
- Licence: Apache-2.0 (`LICENSE`).

Code and documentation are written with AI assistance (Claude) under human direction and review. Built for the NEAR Hackathon (Nov 2026).
