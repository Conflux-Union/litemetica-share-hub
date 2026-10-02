import { reactive } from 'vue'
import { api } from './api'
import type { SiteConfig, User } from './types'

interface AuthState {
  user: User | null
  config: SiteConfig | null
  loaded: boolean
}

const state = reactive<AuthState>({ user: null, config: null, loaded: false })

let loadPromise: Promise<void> | null = null

export function useAuth() {
  const load = () => {
    loadPromise ??= Promise.all([api.me(), api.config()])
      .then(([me, config]) => {
        state.user = me.user
        state.config = config
      })
      .catch(() => {
        /* keep defaults on failure */
      })
      .finally(() => {
        state.loaded = true
      })
    return loadPromise
  }

  const logout = async () => {
    try {
      await api.logout()
    } finally {
      state.user = null
    }
  }

  return { state, load, logout }
}
