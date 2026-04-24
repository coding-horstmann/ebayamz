-- Migration für bestehende Datenbanken:
-- Fügt die Spalte `ebay_condition` hinzu, falls sie noch nicht existiert.
-- Gefahrlos mehrfach ausführbar.

alter table products
  add column if not exists ebay_condition text
  check (ebay_condition in ('NEW','USED'));
