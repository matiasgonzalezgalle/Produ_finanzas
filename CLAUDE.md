# Produ Finanzas: notas para agentes

- Idioma de la UI y del dominio: español (Chile y Perú).
- Montos: enteros en unidad mínima (`src/domain/money.ts`). Nunca sumes monedas distintas; usa `sumByCurrency`.
- Fechas de negocio: strings ISO `YYYY-MM-DD` en la zona horaria de la empresa (`todayIn`, `addDays`). No uses `new Date().toISOString()` para "hoy".
- Pagos: se ligan a documentos solo por `payment_allocations` (ID), nunca por texto o referencia.
- La UI consume solo `DataApi` (`src/data/api.ts`). Toda capacidad nueva va en el contrato y en las dos implementaciones (supabase y demo).
- Toda tabla nueva lleva `tenant_id`, RLS activo, políticas con `private.is_member` / `private.can_write` y grants explícitos. Agrega tests en `supabase/tests/schema.test.ts`.
- Edge functions: exigir JWT con `requireMember`. Las públicas (webhooks) verifican firma y nunca confían en el cuerpo.
- Antes de terminar: `npm run lint && npm test && npm run build`.
