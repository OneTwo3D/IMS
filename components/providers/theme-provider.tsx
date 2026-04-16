'use client'

import { createContext, useContext, useEffect, useMemo, useState } from 'react'

type Theme = 'light' | 'dark' | 'system'
type ResolvedTheme = 'light' | 'dark'

type ThemeContextValue = {
  theme: Theme
  resolvedTheme: ResolvedTheme
  setTheme: (theme: Theme) => void
}

const THEME_STORAGE_KEY = 'theme'

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined)

function resolveTheme(theme: Theme): ResolvedTheme {
  if (theme !== 'system') return theme
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function applyTheme(resolvedTheme: ResolvedTheme) {
  const root = document.documentElement
  root.classList.toggle('dark', resolvedTheme === 'dark')
  root.style.colorScheme = resolvedTheme
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>('system')
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>('light')

  useEffect(() => {
    const storedTheme = (() => {
      try {
        const value = localStorage.getItem(THEME_STORAGE_KEY)
        return value === 'light' || value === 'dark' || value === 'system' ? value : 'system'
      } catch {
        return 'system'
      }
    })()

    const resolved = resolveTheme(storedTheme)
    setThemeState(storedTheme)
    setResolvedTheme(resolved)
    applyTheme(resolved)
  }, [])

  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')

    const handleSystemThemeChange = () => {
      setResolvedTheme((currentResolvedTheme) => {
        if (theme !== 'system') return currentResolvedTheme
        const nextResolvedTheme = mediaQuery.matches ? 'dark' : 'light'
        applyTheme(nextResolvedTheme)
        return nextResolvedTheme
      })
    }

    const handleStorage = (event: StorageEvent) => {
      if (event.key !== THEME_STORAGE_KEY) return
      const nextTheme =
        event.newValue === 'light' || event.newValue === 'dark' || event.newValue === 'system'
          ? event.newValue
          : 'system'
      const nextResolvedTheme = resolveTheme(nextTheme)
      setThemeState(nextTheme)
      setResolvedTheme(nextResolvedTheme)
      applyTheme(nextResolvedTheme)
    }

    mediaQuery.addEventListener('change', handleSystemThemeChange)
    window.addEventListener('storage', handleStorage)

    return () => {
      mediaQuery.removeEventListener('change', handleSystemThemeChange)
      window.removeEventListener('storage', handleStorage)
    }
  }, [theme])

  const setTheme = (nextTheme: Theme) => {
    const nextResolvedTheme = resolveTheme(nextTheme)
    setThemeState(nextTheme)
    setResolvedTheme(nextResolvedTheme)
    applyTheme(nextResolvedTheme)
    try {
      localStorage.setItem(THEME_STORAGE_KEY, nextTheme)
    } catch {
      // Ignore storage failures and keep the in-memory theme.
    }
  }

  const value = useMemo<ThemeContextValue>(
    () => ({ theme, resolvedTheme, setTheme }),
    [theme, resolvedTheme],
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme() {
  const context = useContext(ThemeContext)
  if (!context) {
    throw new Error('useTheme must be used within ThemeProvider')
  }
  return context
}
