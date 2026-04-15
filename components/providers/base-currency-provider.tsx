'use client'

import { createContext, useContext } from 'react'

type BaseCurrencyContextValue = {
  code: string
  symbol: string
  symbolPosition: 'PREFIX' | 'POSTFIX'
}

const BaseCurrencyContext = createContext<BaseCurrencyContextValue>({
  code: 'GBP',
  symbol: '£',
  symbolPosition: 'PREFIX',
})

export function BaseCurrencyProvider({
  value,
  children,
}: {
  value: BaseCurrencyContextValue
  children: React.ReactNode
}) {
  return <BaseCurrencyContext.Provider value={value}>{children}</BaseCurrencyContext.Provider>
}

export function useBaseCurrency() {
  return useContext(BaseCurrencyContext)
}
