'use client'

import { useState, useTransition, useCallback, useEffect } from 'react'
import {
  Search,
  Filter,
  ChevronLeft,
  ChevronRight,
  Info,
  AlertTriangle,
  XCircle,
  ChevronDown,
  ChevronUp,
  Clock,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { getActivityLogs, type ActivityLogRow } from '@/app/actions/activity-log'

const LEVEL_TABS = [
  { key: null, label: 'All' },
  { key: 'INFO' as const, label: 'Info' },
  { key: 'WARNING' as const, label: 'Warning' },
  { key: 'ERROR' as const, label: 'Error' },
]

const TAG_COLOURS: Record<string, string> = {
  sales: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  purchase: 'bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300',
  inventory: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
  stock: 'bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300',
  sync: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/40 dark:text-cyan-300',
  settings: 'bg-slate-100 text-slate-700 dark:bg-slate-900/40 dark:text-slate-300',
  auth: 'bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300',
  import: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300',
  manufacturing: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  system: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
}

const LEVEL_ICON: Record<string, React.ReactNode> = {
  INFO: <Info className="h-3.5 w-3.5 text-blue-500" />,
  WARNING: <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />,
  ERROR: <XCircle className="h-3.5 w-3.5 text-red-500" />,
}

const LEVEL_ROW_STYLE: Record<string, string> = {
  INFO: '',
  WARNING: 'bg-amber-50/50 dark:bg-amber-950/10',
  ERROR: 'bg-red-50/50 dark:bg-red-950/10',
}

type Props = {
  initialRows: ActivityLogRow[]
  initialTotal: number
  availableTags: string[]
}

export function ActivityClient({ initialRows, initialTotal, availableTags }: Props) {
  const [rows, setRows] = useState(initialRows)
  const [total, setTotal] = useState(initialTotal)
  const [isPending, startTransition] = useTransition()

  const [search, setSearch] = useState('')
  const [tag, setTag] = useState<string | null>(null)
  const [level, setLevel] = useState<'INFO' | 'WARNING' | 'ERROR' | null>(null)
  const [page, setPage] = useState(1)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const pageSize = 50
  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  const refresh = useCallback(
    (opts?: { p?: number; s?: string; t?: string | null; l?: string | null }) => {
      const p = opts?.p ?? page
      const s = opts?.s ?? search
      const t = opts?.t !== undefined ? opts.t : tag
      const l = opts?.l !== undefined ? opts.l : level

      startTransition(async () => {
        const result = await getActivityLogs({
          search: s || undefined,
          tag: t || undefined,
          level: (l as 'INFO' | 'WARNING' | 'ERROR') || undefined,
          page: p,
          pageSize,
        })
        setRows(result.rows)
        setTotal(result.total)
      })
    },
    [page, search, tag, level],
  )

  // Debounced search
  const [searchInput, setSearchInput] = useState('')
  useEffect(() => {
    const t = setTimeout(() => {
      setSearch(searchInput)
      setPage(1)
      refresh({ s: searchInput, p: 1 })
    }, 300)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchInput])

  function handleTagFilter(t: string | null) {
    setTag(t)
    setPage(1)
    refresh({ t, p: 1 })
  }

  function handleLevelFilter(l: 'INFO' | 'WARNING' | 'ERROR' | null) {
    setLevel(l)
    setPage(1)
    refresh({ l, p: 1 })
  }

  function handlePage(p: number) {
    setPage(p)
    refresh({ p })
  }

  function formatTime(iso: string) {
    const d = new Date(iso)
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) +
      ' ' +
      d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  }

  function relativeTime(iso: string) {
    const diff = Date.now() - new Date(iso).getTime()
    const mins = Math.floor(diff / 60000)
    if (mins < 1) return 'just now'
    if (mins < 60) return `${mins}m ago`
    const hrs = Math.floor(mins / 60)
    if (hrs < 24) return `${hrs}h ago`
    const days = Math.floor(hrs / 24)
    if (days < 7) return `${days}d ago`
    return formatTime(iso)
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Activity Log</h1>
          <p className="text-sm text-muted-foreground mt-1">{total.toLocaleString()} entries</p>
        </div>
      </div>

      {/* Level tabs */}
      <div className="flex items-center gap-1 border-b">
        {LEVEL_TABS.map((tab) => (
          <button
            key={tab.label}
            type="button"
            onClick={() => handleLevelFilter(tab.key)}
            className={`px-3 py-2 text-sm font-medium border-b-2 transition-colors ${
              level === tab.key
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Filters row */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search activity..."
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="pl-8 h-9"
          />
        </div>

        <div className="flex items-center gap-1">
          <Filter className="h-4 w-4 text-muted-foreground" />
          <Button
            variant={tag === null ? 'secondary' : 'ghost'}
            size="sm"
            className="h-7 text-xs"
            onClick={() => handleTagFilter(null)}
          >
            All
          </Button>
          {availableTags.map((t) => (
            <Button
              key={t}
              variant={tag === t ? 'secondary' : 'ghost'}
              size="sm"
              className="h-7 text-xs capitalize"
              onClick={() => handleTagFilter(t)}
            >
              {t}
            </Button>
          ))}
        </div>
      </div>

      {/* Table */}
      <div className="rounded-lg border overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/50">
              <th className="text-left font-medium px-3 py-2 w-8" />
              <th className="text-left font-medium px-3 py-2 w-40">Time</th>
              <th className="text-left font-medium px-3 py-2 w-20">Level</th>
              <th className="text-left font-medium px-3 py-2 w-24">Tag</th>
              <th className="text-left font-medium px-3 py-2">Description</th>
              <th className="text-left font-medium px-3 py-2 w-32">User</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-3 py-8 text-center text-muted-foreground">
                  No activity log entries found.
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <>
                  <tr
                    key={row.id}
                    className={`border-b hover:bg-muted/30 transition-colors cursor-pointer ${LEVEL_ROW_STYLE[row.level] ?? ''}`}
                    onClick={() => setExpandedId(expandedId === row.id ? null : row.id)}
                  >
                    <td className="px-3 py-2">
                      {row.metadata ? (
                        expandedId === row.id ? (
                          <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" />
                        ) : (
                          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                        )
                      ) : null}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground whitespace-nowrap">
                      <span className="flex items-center gap-1.5">
                        <Clock className="h-3 w-3" />
                        <span title={formatTime(row.createdAt)}>{relativeTime(row.createdAt)}</span>
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <span className="flex items-center gap-1">
                        {LEVEL_ICON[row.level]}
                        <span className="text-xs">{row.level}</span>
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <Badge variant="secondary" className={`text-xs font-normal capitalize ${TAG_COLOURS[row.tag] ?? ''}`}>
                        {row.tag}
                      </Badge>
                    </td>
                    <td className="px-3 py-2">{row.description}</td>
                    <td className="px-3 py-2 text-muted-foreground">{row.userName ?? 'System'}</td>
                  </tr>
                  {expandedId === row.id && row.metadata && (
                    <tr key={`${row.id}-meta`} className="border-b bg-muted/20">
                      <td />
                      <td colSpan={5} className="px-3 py-2">
                        <div className="text-xs space-y-1">
                          <p className="font-medium text-muted-foreground">Details</p>
                          <div className="grid grid-cols-2 gap-x-6 gap-y-0.5">
                            <p><span className="text-muted-foreground">Entity type:</span> {row.entityType.replace(/_/g, ' ').toLowerCase()}</p>
                            {row.entityId && <p><span className="text-muted-foreground">Entity ID:</span> {row.entityId}</p>}
                            <p><span className="text-muted-foreground">Action:</span> {row.action}</p>
                          </div>
                          {typeof row.metadata === 'object' && row.metadata !== null && Object.keys(row.metadata).length > 0 && (
                            <div className="mt-1.5">
                              <p className="font-medium text-muted-foreground mb-0.5">Metadata</p>
                              <pre className="text-xs bg-muted rounded p-2 overflow-x-auto max-h-40">{JSON.stringify(row.metadata, null, 2)}</pre>
                            </div>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            Showing {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, total)} of {total.toLocaleString()}
          </p>
          <div className="flex items-center gap-1">
            <Button variant="outline" size="icon" className="h-8 w-8" disabled={page <= 1 || isPending} onClick={() => handlePage(page - 1)}>
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="text-sm px-2">
              {page} / {totalPages}
            </span>
            <Button variant="outline" size="icon" className="h-8 w-8" disabled={page >= totalPages || isPending} onClick={() => handlePage(page + 1)}>
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}

      {isPending && (
        <div className="fixed bottom-4 right-4 bg-card border rounded-lg px-3 py-2 text-sm shadow-lg flex items-center gap-2">
          <div className="h-3 w-3 rounded-full border-2 border-primary border-t-transparent animate-spin" />
          Loading...
        </div>
      )}
    </div>
  )
}
