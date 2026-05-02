-- BookScout DE – Supabase Schema
-- Einmalig im Supabase SQL Editor ausführen.

create table if not exists products (
  id              bigserial primary key,
  asin            text not null unique,
  isbn13          text,
  title           text,
  image_amazon    text,
  image_ebay      text,
  amazon_price    numeric(10,2),
  ebay_price      numeric(10,2),
  ebay_shipping   numeric(10,2),
  ebay_url        text,
  ebay_condition  text check (ebay_condition in ('NEW','USED')),
  ebay_buying_option text check (ebay_buying_option in ('FIXED_PRICE','AUCTION')),
  bsr             integer,
  monthly_sales   integer,
  profit_euro     numeric(10,2) generated always as (
                    amazon_price - (ebay_price + ebay_shipping)
                  ) stored,
  roi_pct         numeric(10,2) generated always as (
                    case when (ebay_price + ebay_shipping) > 0
                    then ((amazon_price - (ebay_price + ebay_shipping))
                          / (ebay_price + ebay_shipping)) * 100
                    else null end
                  ) stored,
  last_checked    timestamptz default now(),
  created_at      timestamptz default now()
);

create index if not exists products_roi_pct_idx      on products (roi_pct desc);
create index if not exists products_profit_euro_idx  on products (profit_euro desc);
create index if not exists products_bsr_idx          on products (bsr);
create index if not exists products_last_checked_idx on products (last_checked);

create table if not exists worker_state (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz default now()
);
