begin;
alter table public.sg10_gallery
  alter column product set default '',
  drop constraint sg10_gallery_product_check,
  add constraint sg10_gallery_product_check check (char_length(product) <= 120);
commit;
