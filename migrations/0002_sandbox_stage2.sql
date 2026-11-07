-- nearpay-sandbox Stage 2 (lld/sandbox.md v1.4 §3–§5): refund legs and the Explorer mirror.
-- Additive only: Stage 1 rows read scenario_kind 'payment' and no scenario_group (Stage 1 grouping).

alter table sim_quotes
  add column scenario_group text,                     -- pi_… (payment attempts) or re_… (refund legs), as rails sent it
  add column scenario_kind text not null default 'payment' check (scenario_kind in ('payment','refund'));

-- Intents transfers into an INTENTS deposit address record the deposit of its quote (Verifier execute, /sim/intents/transfers).
create index sim_quotes_deposit_address on sim_quotes (deposit_address);
-- Explorer mirror: newest first, optionally by referral.
create index sim_quotes_referral_seq on sim_quotes ((request->>'referral'), seq);
