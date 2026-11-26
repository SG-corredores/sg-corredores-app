-- Match the documented supplier spelling for turmeric sold in trays.
create or replace function sg10_private.commission_product(value text)
returns text language sql immutable set search_path='' as $$
  select case
    when normalized ~ '^curcuma x[0-9]+( [0-9]+)? kg (band|bandeja)( |$)'
      then regexp_replace(normalized, '^curcuma (x[0-9]+( [0-9]+)? kg) (band|bandeja)( |$)', 'curcuma bandeja \1\4')
    else normalized
  end
  from regexp_replace(regexp_replace(sg10_private.product(value), '\majos\M','ajo','g'),'\mkurkuma\M','curcuma','g') as normalized
$$;
