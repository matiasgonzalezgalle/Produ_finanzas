import type { DataApi } from './api'
import { createDemoApi } from './demoApi'
import { createSupabaseApi } from './supabaseApi'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined
const forceDemo = import.meta.env.VITE_DEMO_MODE === 'true'

// Sin credenciales de Supabase la app arranca en modo demo (datos locales del navegador).
export const api: DataApi = !forceDemo && url && anonKey ? createSupabaseApi(url, anonKey) : createDemoApi()

export type { DataApi } from './api'
export * from './types'
