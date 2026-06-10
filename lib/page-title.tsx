'use client'

import { createContext, useContext, useEffect, useState } from 'react'

type PageTitleContextValue = {
  override: string | null
  setOverride: (title: string | null) => void
}

const PageTitleContext = createContext<PageTitleContextValue | null>(null)

export function PageTitleProvider({ children }: { children: React.ReactNode }) {
  const [override, setOverride] = useState<string | null>(null)
  return (
    <PageTitleContext.Provider value={{ override, setOverride }}>
      {children}
    </PageTitleContext.Provider>
  )
}

export function usePageTitleOverride(): string | null {
  const ctx = useContext(PageTitleContext)
  return ctx?.override ?? null
}

export function PageTitle({ title }: { title: string }) {
  const ctx = useContext(PageTitleContext)
  useEffect(() => {
    if (!ctx) return
    ctx.setOverride(title)
    return () => ctx.setOverride(null)
  }, [ctx, title])
  return null
}
