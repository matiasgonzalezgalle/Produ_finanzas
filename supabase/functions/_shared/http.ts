// Utilidades HTTP comunes. CORS restringido a los orígenes configurados en ALLOWED_ORIGINS.
const allowedOrigins = (Deno.env.get('ALLOWED_ORIGINS') ?? '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean)

export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('origin') ?? ''
  const allow = allowedOrigins.includes(origin) ? origin : allowedOrigins[0] ?? ''
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  }
}

export function json(req: Request, status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), 'Content-Type': 'application/json' },
  })
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

/** Envuelve un handler: maneja OPTIONS, errores y nunca filtra detalles internos. */
export function handler(fn: (req: Request) => Promise<Response>) {
  return async (req: Request): Promise<Response> => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req) })
    try {
      return await fn(req)
    } catch (error) {
      if (error instanceof HttpError) return json(req, error.status, { error: error.message })
      console.error(error)
      return json(req, 500, { error: 'Error interno' })
    }
  }
}
