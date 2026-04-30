-- Persistenter Worker-Fortschritt, z.B. naechster Keepa-BSR-Start.

create table if not exists worker_state (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz default now()
);
