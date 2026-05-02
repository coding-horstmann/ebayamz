-- Speichert, ob der gefundene eBay-Treffer Sofortkauf oder Auktion ist.

alter table products
  add column if not exists ebay_buying_option text
  check (ebay_buying_option in ('FIXED_PRICE','AUCTION'));

update products
set ebay_buying_option = 'FIXED_PRICE'
where ebay_price is not null
  and ebay_buying_option is null;
