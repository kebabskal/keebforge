import { create } from 'zustand'

export type Theme = 'dark' | 'light'

const STORAGE_KEY = 'keebforge.theme'

function initialTheme(): Theme {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved === 'light' || saved === 'dark') return saved
  } catch {
    // fall through to OS preference
  }
  if (typeof window === 'undefined') return 'dark' // headless (dev scripts)
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

export const useTheme = create<{ theme: Theme; toggle: () => void }>((set, get) => ({
  theme: initialTheme(),
  toggle: () => {
    const theme: Theme = get().theme === 'dark' ? 'light' : 'dark'
    try {
      localStorage.setItem(STORAGE_KEY, theme)
    } catch {
      // best-effort persistence
    }
    set({ theme })
  },
}))

function apply(theme: Theme) {
  if (typeof document === 'undefined') return // headless (dev scripts)
  document.documentElement.dataset.theme = theme
}

apply(useTheme.getState().theme)
useTheme.subscribe((s) => apply(s.theme))
