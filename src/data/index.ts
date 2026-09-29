import type { DataApi } from './api'
import { createDemoApi } from './demoApi'
import { createSupabaseApi } from './supabaseApi'
import { PUBLIC_SUPABASE_ANON_KEY, PUBLIC_SUPABASE_URL } from '../config/public'

// Las variables de entorno permiten apuntar a otro proyecto (ej. staging); si no están, se usa el público.
const url = (import.meta.env.VITE_SUPABASE_URL as string | undefined) || PUBLIC_SUPABASE_URL
const anonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined) || PUBLIC_SUPABASE_ANON_KEY
const forceDemo = import.meta.env.VITE_DEMO_MODE === 'true'

// VITE_DEMO_MODE=true arranca en modo demo (datos locales del navegador, sin backend).
export const api: DataApi = !forceDemo && url && anonKey ? createSupabaseApi(url, anonKey) : createDemoApi()

export type { DataApi } from './api'
export * from './types'
