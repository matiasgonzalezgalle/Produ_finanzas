import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { api } from '../data'
import type { Session } from '../data/api'

interface SessionState {
  session: Session | null
  loading: boolean
}

const SessionContext = createContext<SessionState>({ session: null, loading: true })

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SessionState>({ session: null, loading: true })

  useEffect(() => {
    let active = true
    api.getSession().then((session) => active && setState({ session, loading: false }))
    const unsubscribe = api.onSessionChange((session) => setState({ session, loading: false }))
    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  return <SessionContext.Provider value={state}>{children}</SessionContext.Provider>
}

export const useSession = () => useContext(SessionContext)
