-- nearpay-sandbox Stage 4 (lld/sandbox.md v1.7 §3.1, §5, §10): the subscription-vault stand-in, simulated NEP-141
-- ledgers and NEAR transactions, receipt context on the indexer feed, Solana/Bitcoin chain fields. Additive only.

-- ---------------------------------------------------------------- vault stand-in (contracts-vault §2 state)
create table sim_vault_mandates (
  mandate_id bigint primary key,
  payer text not null,
  state jsonb not null,                               -- the contract's Mandate (amounts as decimal strings)
  clock_offset_s bigint not null default 0 check (clock_offset_s >= 0),   -- /sim/vault/advance (forward only)
  refunds_failed smallint not null default 0,         -- scenario 93 bookkeeping
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now());

-- Singleton: next mandate id and per-token TVL ({token: "u128"}).
create table sim_vault_state (
  id boolean primary key default true check (id),
  next_id bigint not null default 0,
  tvl jsonb not null default '{}');
insert into sim_vault_state (id) values (true);

-- NEP-145 storage accounts.
create table sim_vault_storage (
  account_id text primary key,
  total numeric(78,0) not null check (total >= 0),
  mandates int not null check (mandates >= 0));

-- Open mandate ids per payer in the contract's IterableSet order (swap_remove on close).
create table sim_vault_payer_index (
  payer text primary key,
  mandate_ids jsonb not null);

-- Simulated NEP-141 ledgers of the test tokens (payers, the vault, treasury, near_account merchants, intents.near).
create table sim_ft_balances (
  token text not null,
  account_id text not null,
  amount numeric(78,0) not null check (amount >= 0),
  primary key (token, account_id));

-- NEAR access keys registered on first use, with the last used nonce (u64).
create table sim_access_keys (
  account_id text not null,
  public_key text not null,
  nonce numeric(20,0) not null default 0,
  created_at timestamptz not null default now(),
  primary key (account_id, public_key));

-- Final outcomes of stand-in transactions (`tx` and idempotent re-sends).
create table sim_near_txs (
  hash text primary key,
  signer_id text not null,
  outcome jsonb not null,
  created_at timestamptz not null default now());

-- ---------------------------------------------------------------- indexer feed: receipt context + commit-ordered cursor
alter table sim_intents_events
  add column receipt_id text,
  add column log_index int,
  add column executor_id text,
  add column block_hash text,
  add column block_timestamp text,
  add column receipt_status text check (receipt_status in ('success','failure')),
  add column pos bigint;

-- The feed's cursor is `pos`, assigned at commit under one lock, so positions become visible in order: a reader can
-- never see position n+1 while n is still uncommitted and skip it (sequence values are allocated at insert time and
-- concurrent transactions commit out of order). Existing rows keep their seq as position.
update sim_intents_events set pos = seq;
create unique index sim_intents_events_pos on sim_intents_events (pos);
create sequence sim_intents_feed_pos;
select setval('sim_intents_feed_pos', coalesce((select max(seq) from sim_intents_events), 0) + 1, false);

create function sim_intents_events_assign_pos() returns trigger language plpgsql as $$
begin
  perform pg_advisory_xact_lock(hashtext('sandbox:feed'));
  update sim_intents_events set pos = nextval('sim_intents_feed_pos') where seq = new.seq;
  return null;
end $$;

create constraint trigger sim_intents_events_pos_at_commit
  after insert on sim_intents_events
  deferrable initially deferred
  for each row execute function sim_intents_events_assign_pos();

-- ---------------------------------------------------------------- Solana / Bitcoin chain fields (§10)
create sequence sim_chain_block_seq;
alter table sim_txs
  add column block_ref text,                          -- Solana slot / Bitcoin height; null on rows before v1.6
  add column failed boolean not null default false;   -- Solana: landed but failed (meta.err)
-- Bitcoin confirmations are derived at read time from finalized_at (the first confirmation) and the time scale.
