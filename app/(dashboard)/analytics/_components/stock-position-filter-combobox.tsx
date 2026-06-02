'use client'

import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { ChevronDown, X } from 'lucide-react'
import type {
  StockPositionFilterOption,
  StockPositionFilterOptionPage,
  StockPositionFilterOptionType,
} from '@/lib/domain/inventory/stock-position-reports'
import { cn } from '@/lib/utils'

type StockPositionFilterComboboxProps = {
  id: string
  name: string
  type: StockPositionFilterOptionType
  allLabel: string
  value?: string
  initialOptions: StockPositionFilterOption[]
}

function optionMatches(option: StockPositionFilterOption, query: string): boolean {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return true
  return option.label.toLowerCase().includes(normalized) || option.description?.toLowerCase().includes(normalized) === true
}

export function StockPositionFilterCombobox({
  id,
  name,
  type,
  allLabel,
  value,
  initialOptions,
}: StockPositionFilterComboboxProps) {
  const listboxId = `${id}-listbox`
  const reactId = useId()
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const initialSelected = useMemo(
    () => initialOptions.find((option) => option.id === value) ?? null,
    [initialOptions, value],
  )
  const [selected, setSelected] = useState<StockPositionFilterOption | null>(initialSelected)
  const [query, setQuery] = useState('')
  const [options, setOptions] = useState(initialOptions)
  const [open, setOpen] = useState(false)
  const [highlightedIndex, setHighlightedIndex] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setSelected(initialSelected)
  }, [initialSelected])

  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    const params = new URLSearchParams({ type, q: query })
    if (selected) params.set('selectedId', selected.id)
    setLoading(true)
    setError(null)
    fetch(`/api/stock-position/filter-options?${params}`, {
      signal: controller.signal,
      cache: 'no-store',
    })
      .then(async (response) => {
        if (!response.ok) throw new Error('Could not load options')
        return await response.json() as StockPositionFilterOptionPage
      })
      .then((page) => {
        setOptions(page.options)
        setHighlightedIndex(0)
      })
      .catch((fetchError: unknown) => {
        if (fetchError instanceof DOMException && fetchError.name === 'AbortError') return
        setError(fetchError instanceof Error ? fetchError.message : 'Could not load options')
      })
      .finally(() => setLoading(false))
    return () => controller.abort()
  }, [open, query, selected, type])

  const visibleOptions = useMemo(
    () => options.filter((option) => optionMatches(option, query)),
    [options, query],
  )
  const displayValue = open ? query : selected?.label ?? ''
  const activeOptionId = open && visibleOptions[highlightedIndex]
    ? `${id}-${reactId}-${visibleOptions[highlightedIndex].id}`
    : undefined

  function close() {
    setOpen(false)
    setQuery('')
    setHighlightedIndex(0)
  }

  function selectOption(option: StockPositionFilterOption | null) {
    setSelected(option)
    close()
  }

  function clearSelected() {
    selectOption(null)
  }

  return (
    <div className="relative">
      <input type="hidden" name={name} value={selected?.id ?? ''} />
      <div className="relative">
        <input
          id={id}
          type="text"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-activedescendant={activeOptionId}
          autoComplete="off"
          value={displayValue}
          placeholder={allLabel}
          className="h-9 w-full rounded-md border border-input bg-background px-2 pr-16 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onFocus={() => {
            if (blurTimer.current) clearTimeout(blurTimer.current)
            setOpen(true)
          }}
          onBlur={() => {
            blurTimer.current = setTimeout(close, 120)
          }}
          onChange={(event) => {
            setQuery(event.target.value)
            setOpen(true)
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              setOpen(true)
              setHighlightedIndex((index) => Math.min(index + 1, Math.max(visibleOptions.length - 1, 0)))
            } else if (event.key === 'ArrowUp') {
              event.preventDefault()
              setOpen(true)
              setHighlightedIndex((index) => Math.max(index - 1, 0))
            } else if (event.key === 'Enter' && open) {
              event.preventDefault()
              const option = visibleOptions[highlightedIndex]
              if (option) selectOption(option)
            } else if (event.key === 'Escape') {
              event.preventDefault()
              close()
            }
          }}
        />
        {selected && (
          <button
            type="button"
            aria-label={`Clear ${allLabel}`}
            className="absolute right-8 top-1/2 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            onMouseDown={(event) => {
              event.preventDefault()
              clearSelected()
            }}
            onClick={clearSelected}
          >
            <X className="h-4 w-4" />
          </button>
        )}
        <button
          type="button"
          aria-label={`Open ${allLabel}`}
          className="absolute right-1 top-1/2 inline-flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => setOpen((value) => !value)}
        >
          <ChevronDown className="h-4 w-4" />
        </button>
      </div>

      {open && (
        <div className="absolute z-30 mt-1 max-h-60 w-full overflow-auto rounded-md border bg-popover p-1 text-sm shadow-md">
          <button
            type="button"
            className={cn(
              'flex w-full items-center rounded-sm px-2 py-1.5 text-left hover:bg-muted',
              selected == null && 'bg-muted',
            )}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => selectOption(null)}
          >
            {allLabel}
          </button>
          <ul id={listboxId} role="listbox" aria-label={allLabel}>
            {visibleOptions.map((option, index) => (
              <li
                id={`${id}-${reactId}-${option.id}`}
                key={option.id}
                role="option"
                aria-selected={selected?.id === option.id}
                className={cn(
                  'cursor-pointer rounded-sm px-2 py-1.5',
                  index === highlightedIndex && 'bg-muted',
                  selected?.id === option.id && 'font-medium',
                )}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setHighlightedIndex(index)}
                onClick={() => selectOption(option)}
              >
                <span>{option.label}</span>
                {option.description && option.description !== option.label && (
                  <span className="ml-2 text-xs text-muted-foreground">{option.description}</span>
                )}
              </li>
            ))}
          </ul>
          {loading && <p className="px-2 py-1.5 text-muted-foreground">Loading...</p>}
          {!loading && !error && visibleOptions.length === 0 && (
            <p className="px-2 py-1.5 text-muted-foreground">No matches</p>
          )}
          {error && <p className="px-2 py-1.5 text-destructive">{error}</p>}
        </div>
      )}
    </div>
  )
}
