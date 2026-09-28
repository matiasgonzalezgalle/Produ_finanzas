# Produ Finanzas

SaaS multi-empresa de **tesorería, cuentas por pagar y cuentas por cobrar** para Chile y Perú.

- Proveedores, clientes y contactos, con validación de RUT y RUC.
- Documentos: facturas, boletas, notas de crédito y débito, honorarios e invoices en CLP, PEN, USD, EUR o UF.
- Pagos y cobros asignados a documentos **por ID**, sin sobrepagos, sin mezclar monedas y en una sola transacción.
- IVA del 19% o IGV del 18%, y detracciones SUNAT (se depositan en soles enteros).
- Tesorería: posición neta por moneda, antigüedad de saldos (aging), vencimientos de los próximos 30 días y flujo del mes.
- Cobro con **link de MercadoPago**. El pago se registra solo cuando el webhook llega firmado y el pago se verifica con la API de MercadoPago.

## Stack

| Capa | Tecnología |
| --- | --- |
| Frontend | React 19, TypeScript, Vite, Tailwind CSS 4, TanStack Query, React Router |
| Backend | Supabase: Postgres con RLS, Auth y Edge Functions en Deno |
| Tests | Vitest. El SQL se prueba sobre Postgres real embebido (PGlite) |

## Desarrollo

```bash
npm install
npm run dev        # sin .env.local arranca en modo demo, con datos locales del navegador
npm test           # dominio, esquema SQL/RLS y webhooks
npm run build
```

## Estructura

```
src/
  domain/        Reglas de negocio puras y testeadas: montos, RUT/RUC, fechas, saldos
  data/          Contrato DataApi y sus implementaciones Supabase y demo
  app/           Sesión, empresa activa y hooks de datos
  features/      Pantallas: empresas, documentos, pagos, tesorería, integraciones
  ui/            Componentes base
supabase/
  migrations/    Esquema, RLS, triggers de validación y RPCs
  functions/     Edge functions de MercadoPago
  tests/         Tests del esquema y de las firmas de webhook
```

## Principios de diseño

1. **Aislamiento por empresa:** toda tabla tiene `tenant_id` y RLS por membresía. Además, las FKs compuestas `(tenant_id, id)` impiden cruzar datos entre empresas.
2. **Roles:** `owner`, `admin`, `finance` y `viewer`. `viewer` solo lee.
3. **Montos:** siempre `bigint` en la unidad mínima de su moneda (CLP con 0 decimales, PEN/USD/EUR con 2, UF con 4). Nunca se usan floats.
4. **Saldos:** los calcula la vista `document_balances` en la base de datos, con la fecha de hoy en la zona horaria de la empresa.
5. **Secretos de integraciones:** viven en `integration_secrets`, sin acceso para `anon` ni `authenticated`. Solo los leen las edge functions.
6. **Integraciones:** cada proveedor es un conjunto de edge functions más filas en `integration_connections`, `payment_links` y `webhook_events` (idempotencia y trazabilidad). Para agregar uno nuevo se agrega su `provider` y sus funciones.
7. **Auditoría:** los triggers registran en `audit_log` cada cambio en documentos, pagos, asignaciones, contrapartes y miembros.

## Despliegue en Supabase

```bash
npx supabase login
npx supabase link --project-ref <ref>
npx supabase db push
npx supabase secrets set ALLOWED_ORIGINS=https://app.tudominio.cl APP_URL=https://app.tudominio.cl
npx supabase functions deploy mercadopago-connect mercadopago-create-link mercadopago-webhook
```

Después, en el dashboard de Supabase:

- Configura **Auth > URL Configuration** con el dominio de la app.
- Activa la confirmación de correo.

Luego copia `.env.example` a `.env.local` con la URL y la anon key del proyecto.

### MercadoPago

Cada empresa conecta su cuenta en **Integraciones**, con su access token y la clave secreta de webhooks. Después configura en MercadoPago la URL de webhook que muestra la app, con el evento **Pagos**.
