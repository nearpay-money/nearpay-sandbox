-- nearpay-sandbox (lld/sandbox.md §5): simulated quotes and their timelines, simulated chain
-- transactions, and the simulated NEAR Intents Verifier (balances, nonces, keys, event feed).

create sequence sim_quote_seq;
create sequence sim_block_height start with 150000000;

create table sim_quotes (
  deposit_key text primary key,                       -- deposit_address || '|' || coalesce(memo, '')
  seq bigint not null unique,
  deposit_address text not null,
  deposit_memo text,
  correlation_id uuid not null,
  request jsonb not null,                             -- the 1Click quote request as received
  response jsonb not null,                            -- the signed quote response
  scenario text not null check (scenario ~ '^[0-9]{2}$'),
  group_key text not null,                            -- same payment (scenario 06 siblings)
  origin_chain text not null,
  destination_chain text not null,
  amount_in numeric(78,0) not null,
  min_amount_in numeric(78,0) not null,
  amount_out numeric(78,0) not null,
  deadline timestamptz not null,
  state text not null check (state in ('PENDING_DEPOSIT','KNOWN_DEPOSIT_TX','INCOMPLETE_DEPOSIT','PROCESSING','SUCCESS','REFUNDED','FAILED')),
  manual boolean not null default false,              -- advanced by /sim/advance: the timeline stopped
  deposited_amount numeric(78,0),
  deposited_at timestamptz,
  deposit_tx_hashes text[] not null default '{}',
  timeline jsonb not null default '[]',
  applied smallint not null default 0,
  next_at timestamptz,
  delivered_amount numeric(78,0),
  refunded_amount numeric(78,0),
  refund_reason text,
  destination_tx_hashes text[] not null default '{}',
  refund_tx_hashes text[] not null default '{}',
  near_tx_hashes text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now());
create index sim_quotes_due on sim_quotes (next_at) where next_at is not null;
create index sim_quotes_group on sim_quotes (group_key, created_at) where state = 'PENDING_DEPOSIT';

create table sim_txs (
  hash text primary key,
  chain text not null,
  transfers jsonb not null,                           -- [{token, to, amount}]
  finalized_at timestamptz not null,
  created_at timestamptz not null default now());

create table sim_intents_balances (
  account_id text not null,
  token text not null,
  amount numeric(78,0) not null check (amount >= 0),
  primary key (account_id, token));

create table sim_intents_nonces (
  account_id text not null,
  nonce text not null,
  created_at timestamptz not null default now(),
  primary key (account_id, nonce));

-- Keys allowed to sign for named accounts: registered on first use (implicit accounts need none).
create table sim_intents_keys (
  account_id text not null,
  public_key text not null,
  created_at timestamptz not null default now(),
  primary key (account_id, public_key));

create table sim_intents_events (
  seq bigserial primary key,
  tx_hash text not null,
  block_height bigint not null,
  log text not null,
  created_at timestamptz not null default now());
