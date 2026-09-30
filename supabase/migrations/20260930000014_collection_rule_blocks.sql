-- Editor de plantillas por bloques: texto con formato (HTML restringido), ficha/tabla de documentos,
-- botón de pago y separadores, en el orden que defina la empresa. El HTML se vuelve a limpiar al
-- enviar (lista blanca de etiquetas) y al mostrarlo en el editor.
alter table public.collection_rules add column if not exists blocks jsonb
  check (blocks is null or (jsonb_typeof(blocks) = 'array' and length(blocks::text) <= 40000));
