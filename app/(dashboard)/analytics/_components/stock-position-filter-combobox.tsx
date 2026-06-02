'use client'

import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { ChevronDown, X } from 'lucide-react'
import type {
  StockPositionFilterOption,
  StockPositionFilterOptionPage,
  StockPositionFilterOptionType,
} from '@/lib/domain/inventory/stock-position-reports'
import { cn } from '@/lib/utils'

const SEARCH_DEBOUNCE_MS = 250

type StockPositionFilterComboboxProps = {
  id: string
  name: string
  type: StockPositionFilterOptionType
  allLabel: string
  value?: string
  initialOptions: StockPositionFilterOption[]
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
  const inputRef = useRef<HTMLInputElement | null>(null)
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const selectedIdRef = useRef(value ?? '')
  const highlightedOptionIdRef = useRef<string | null>(null)
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
    if (!open) return
    let controller: AbortController | null = null

    const debounce = setTimeout(() => {
      setLoading(true)
      setError(null)
      controller = new AbortController()
      const params = new URLSearchParams({ type, q: query })
      if (selectedIdRef.current) params.set('selectedId', selectedIdRef.current)
      fetch(`/api/stock-position/filter-options?${params}`, {
        signal: controller.signal,
        cache: 'no-store',
      })
        .then(async (response) => {
          if (response.status === 401) {
            window.location.assign(`/login?callbackUrl=${encodeURIComponent(window.location.pathname + window.location.search)}`)
            return null
          }
          if (!response.ok) throw new Error(`Could not load options (HTTP ${response.status})`)
          return await response.json() as StockPositionFilterOptionPage
        })
        .then((page) => {
          if (!page) return
          setOptions(page.options)
          setHighlightedIndex((index) => {
            const highlightedId = highlightedOptionIdRef.current
            const anchoredIndex = highlightedId
              ? page.options.findIndex((option) => option.id === highlightedId)
              : -1
            const nextIndex = anchoredIndex >= 0
              ? anchoredIndex
              : Math.min(index, Math.max(page.options.length - 1, 0))
            highlightedOptionIdRef.current = page.options[nextIndex]?.id ?? null
            return nextIndex
          })
        })
        .catch((fetchError: unknown) => {
          if (fetchError instanceof DOMException && fetchError.name === 'AbortError') return
          setError(fetchError instanceof Error ? fetchError.message : 'Could not load options')
        })
        .finally(() => setLoading(false))
    }, SEARCH_DEBOUNCE_MS)

    return () => {
      clearTimeout(debounce)
      controller?.abort()
    }
  }, [open, query, type])

  const visibleOptions = options
  const displayValue = open ? query : selected?.label ?? ''
  const activeOptionId = open && visibleOptions[highlightedIndex]
    ? `${id}-${reactId}-${visibleOptions[highlightedIndex].id}`
    : undefined

  function close() {
    setOpen(false)
    setQuery('')
    setHighlightedIndex(0)
    setLoading(false)
  }

  function selectOption(option: StockPositionFilterOption | null) {
    setSelected(option)
    selectedIdRef.current = option?.id ?? ''
    close()
  }

  function clearSelected() {
    selectOption(null)
  }

  function openCombobox() {
    if (blurTimer.current) clearTimeout(blurTimer.current)
    setQuery(selected?.label ?? '')
    setOpen(true)
    requestAnimationFrame(() => inputRef.current?.select())
  }

  return (
    <div className="relative">
      {selected && <input type="hidden" name={name} value={selected.id} />}
      <div className="relative">
        <input
          id={id}
          ref={inputRef}
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
          onFocus={openCombobox}
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
              setHighlightedIndex((index) => {
                const nextIndex = Math.min(index + 1, Math.max(visibleOptions.length - 1, 0))
                highlightedOptionIdRef.current = visibleOptions[nextIndex]?.id ?? null
                return nextIndex
              })
            } else if (event.key === 'ArrowUp') {
              event.preventDefault()
              setOpen(true)
              setHighlightedIndex((index) => {
                const nextIndex = Math.max(index - 1, 0)
                highlightedOptionIdRef.current = visibleOptions[nextIndex]?.id ?? null
                return nextIndex
              })
            } else if (event.key === 'Enter' && open && !loading) {
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
        <div className="absolute z-30 mt-1 max-h-60 w-full overflow-auto rounded-md border bg-popover p-1 text-sm shadow-md" aria-busy={loading}>
          <button
            type="button"
            className={cn(
              'flex w-full items-center rounded-sm px-2 py-1.5 text-left hover:bg-muted',
              selected == null && 'bg-muted',
              loading && 'pointer-events-none opacity-60',
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
                  loading && 'pointer-events-none opacity-60',
                )}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => {
                  highlightedOptionIdRef.current = option.id
                  setHighlightedIndex(index)
                }}
                onClick={() => {
                  if (!loading) selectOption(option)
                }}
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
