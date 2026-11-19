'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import {
  confirmMintsoftSupplierMapping,
  createMintsoftSupplierFromIms,
  refreshMintsoftSuppliers,
  resolveUnknownMintsoftSupplierCreate,
  saveMintsoftSupplierSwitches,
  saveMintsoftTransferSupplier,
  unmapMintsoftSupplier,
} from '@/app/actions/mintsoft-suppliers'
import type { DuplicateCandidate, SupplierMappingRow, SupplierMappingScreen } from '@/lib/connectors/mintsoft/suppliers/mapping'

type Notice = { kind: 'ok' | 'error'; text: string } | null

const STATE_LABEL: Record<SupplierMappingRow['state'], string> = {
  UNMAPPED: 'Not mapped',
  MAPPED: 'Mapped',
  CREATE_PENDING: 'Create in Mintsoft: pending (creating is switched off)',
  CREATING: 'Create in progress, or its outcome is unknown: check Mintsoft. It cannot be unmapped or re-created; an administrator settles it with "Resolve unknown outcome".',
}

export function MintsoftSuppliersClient({ screen }: { screen: SupplierMappingScreen }) {
  const router = useRouter()
  const [notice, setNotice] = useState<Notice>(null)
  const [pending, startTransition] = useTransition()
  const [picked, setPicked] = useState<Record<string, string>>({})
  const [shrinkRefused, setShrinkRefused] = useState(false)
  const [filter, setFilter] = useState<'all' | 'needs'>('needs')

  // Rows whose create was refused by the duplicate guard: the similar suppliers, and the reason typed for "create anyway".
  const [similar, setSimilar] = useState<Record<string, { duplicates: DuplicateCandidate[]; reason: string }>>({})
  // The "resolve unknown outcome" form per row.
  const [resolve, setResolve] = useState<Record<string, { externalId: string; reason: string }>>({})

  function run(task: () => Promise<{ success: boolean; error?: string; message?: string; warning?: string; duplicates?: DuplicateCandidate[]; shrinkRefused?: boolean }>, supplierId?: string) {
    setNotice(null)
    startTransition(async () => {
      const result = await task()
      if (supplierId) setSimilar((current) => { const next = { ...current }; if (!result.success && result.duplicates?.length) next[supplierId] = { duplicates: result.duplicates, reason: current[supplierId]?.reason ?? '' }; else delete next[supplierId]; return next })
      setShrinkRefused(Boolean(result.shrinkRefused))
      setNotice(result.success ? { kind: 'ok', text: `${result.message ?? 'Saved.'}${result.warning ? ` ${result.warning}` : ''}` } : { kind: 'error', text: result.error ?? 'Failed.' })
      router.refresh()
    })
  }

  const rows = filter === 'needs' ? screen.rows.filter((row) => row.state !== 'MAPPED' || row.mappedMissing) : screen.rows

  return (
    <div className="space-y-4">
      {notice && (
        <div role="status" className={`rounded border p-2 text-sm ${notice.kind === 'error' ? 'border-destructive text-destructive' : 'border-border'}`}>{notice.text}</div>
      )}

      <Card className="space-y-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-sm">
            <strong>{screen.counts.mapped}</strong> of {screen.counts.total} suppliers mapped, <strong>{screen.counts.unmapped}</strong> not mapped
            {screen.counts.pending > 0 && <>, {screen.counts.pending} create choices waiting</>}.{' '}
            <span className={screen.cacheStale ? 'text-destructive' : 'text-muted-foreground'}>
              Mintsoft list read {screen.lastSyncedAt ? `${new Date(screen.lastSyncedAt).toLocaleString()} (${ageText(screen.lastSyncedAt)} ago)` : 'never'} ({screen.remote.length} active suppliers).
              {screen.cacheStale && <> Older than {screen.cacheMaxAgeMinutes} minutes: refresh before creating a supplier in Mintsoft.</>}
            </span>
          </div>
          <Button type="button" variant="outline" disabled={pending} onClick={() => run(() => refreshMintsoftSuppliers())}>Refresh Mintsoft supplier list (read-only)</Button>
          {shrinkRefused && screen.viewerIsAdmin && (
            <Button type="button" variant="destructive" disabled={pending} onClick={() => run(() => refreshMintsoftSuppliers({ confirmShrink: true }))}>The shorter list is real: read it anyway</Button>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <label htmlFor="transfer-supplier">Supplier carried by transfer ASNs</label>
          <select
            id="transfer-supplier"
            className="rounded border bg-background px-2 py-1"
            defaultValue={screen.transferSupplierId ?? ''}
            disabled={pending}
            onChange={(event) => run(() => saveMintsoftTransferSupplier(event.target.value))}
          >
            <option value="">Not chosen</option>
            {screen.rows.map((row) => <option key={row.supplierId} value={row.supplierId}>{row.name}</option>)}
          </select>
          <span className="text-xs text-muted-foreground">Administrators only, fresh sign-in. Owner decision: &quot;One Two Enterprises Ltd&quot;. Map it below like any other supplier.</span>
        </div>
      </Card>

      <Card className="space-y-2 p-4">
        <h2 className="text-sm font-medium">Switches (administrators)</h2>
        <SwitchesForm screen={screen} disabled={pending} onSave={(value) => run(() => saveMintsoftSupplierSwitches(value))} />
      </Card>

      <div className="flex items-center gap-2 text-sm">
        <Button type="button" size="sm" variant={filter === 'needs' ? 'default' : 'outline'} onClick={() => setFilter('needs')}>Needs a decision</Button>
        <Button type="button" size="sm" variant={filter === 'all' ? 'default' : 'outline'} onClick={() => setFilter('all')}>All suppliers</Button>
      </div>

      <div className="space-y-2">
        {rows.length === 0 && <p className="text-sm text-muted-foreground">Every supplier is mapped.</p>}
        {rows.map((row) => (
          <Card key={row.supplierId} className="space-y-2 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="font-medium">{row.name}{screen.transferSupplierId === row.supplierId ? ' (transfer supplier)' : ''}</div>
                <div className="text-xs text-muted-foreground">
                  {row.state === 'MAPPED' && !row.mappedMissing && <>Mapped to Mintsoft supplier {row.externalSupplierId} ({row.mappedName})</>}
                  {row.state === 'MAPPED' && row.mappedMissing && <span className="text-destructive">Mapped to Mintsoft supplier {row.externalSupplierId}, which is {row.mappedInactive ? 'inactive in Mintsoft' : 'no longer in the latest read of Mintsoft'}. It is not sent on ASNs. Choose another.</span>}
                  {row.sharedWith.length > 0 && <span className="block text-amber-600">Also mapped to the same Mintsoft supplier: {row.sharedWith.join(', ')}. Check this is intended.</span>}
                  {row.state !== 'MAPPED' && STATE_LABEL[row.state]}
                </div>
              </div>
              {(row.state === 'MAPPED' || row.state === 'CREATE_PENDING') && (
                <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => run(() => unmapMintsoftSupplier(row.supplierId))}>Unmap</Button>
              )}
            </div>

            {row.state === 'CREATING' && (
              <div className="space-y-2 text-sm">
                {screen.viewerIsAdmin ? (
                  <>
                    <div className="text-xs text-muted-foreground">Refresh the Mintsoft list, look for this supplier in Mintsoft, then record what you found. A reason is required and is kept in the audit.</div>
                    <div className="flex flex-wrap items-center gap-2">
                      <input
                        aria-label={`Reason for ${row.name}`}
                        className="min-w-64 rounded border bg-background px-2 py-1"
                        placeholder="Reason (what you checked)"
                        value={resolve[row.supplierId]?.reason ?? ''}
                        onChange={(event) => setResolve((current) => ({ ...current, [row.supplierId]: { externalId: current[row.supplierId]?.externalId ?? '', reason: event.target.value } }))}
                      />
                      <input
                        aria-label={`Mintsoft supplier id found for ${row.name}`}
                        className="w-40 rounded border bg-background px-2 py-1"
                        placeholder="Mintsoft id found"
                        value={resolve[row.supplierId]?.externalId ?? ''}
                        onChange={(event) => setResolve((current) => ({ ...current, [row.supplierId]: { reason: current[row.supplierId]?.reason ?? '', externalId: event.target.value } }))}
                      />
                      <Button type="button" size="sm" variant="outline" disabled={pending}
                        onClick={() => run(() => resolveUnknownMintsoftSupplierCreate({ supplierId: row.supplierId, reason: resolve[row.supplierId]?.reason ?? '', outcome: { kind: 'FOUND', externalSupplierId: resolve[row.supplierId]?.externalId ?? '' } }))}
                      >Resolve unknown outcome: found, map it</Button>
                      <Button type="button" size="sm" variant="outline" disabled={pending}
                        onClick={() => run(() => resolveUnknownMintsoftSupplierCreate({ supplierId: row.supplierId, reason: resolve[row.supplierId]?.reason ?? '', outcome: { kind: 'NOT_CREATED' } }))}
                      >Resolve unknown outcome: not created</Button>
                    </div>
                  </>
                ) : (
                  <div className="text-xs text-muted-foreground">Ask an administrator to resolve this.</div>
                )}
              </div>
            )}

            {(row.state === 'UNMAPPED' || row.state === 'CREATE_PENDING' || row.mappedMissing) && (
              <div className="space-y-2">
                {row.suggestions.length === 0 && <div className="text-xs text-muted-foreground">No close match in the Mintsoft list.</div>}
                {row.suggestions.map((suggestion) => (
                  <div key={suggestion.externalId} className="flex flex-wrap items-center gap-2 text-sm">
                    <span>{suggestion.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {suggestion.score}% match{suggestion.signals.length > 0 ? `, same ${suggestion.signals.join(' and ')}` : ''}
                    </span>
                    <Button
                      type="button"
                      size="sm"
                      disabled={pending}
                      onClick={() => run(() => confirmMintsoftSupplierMapping({ supplierId: row.supplierId, externalSupplierId: suggestion.externalId, source: 'OPERATOR_CONFIRMED_SUGGESTION', suggestionScore: suggestion.score }))}
                    >Confirm</Button>
                  </div>
                ))}
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <select
                    aria-label={`Mintsoft supplier for ${row.name}`}
                    className="rounded border bg-background px-2 py-1"
                    value={picked[row.supplierId] ?? ''}
                    onChange={(event) => setPicked((current) => ({ ...current, [row.supplierId]: event.target.value }))}
                  >
                    <option value="">Pick any Mintsoft supplier</option>
                    {screen.remote.map((remote) => <option key={remote.externalId} value={remote.externalId}>{remote.name}{remote.code ? ` (${remote.code})` : ''}</option>)}
                  </select>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={pending || !picked[row.supplierId]}
                    onClick={() => run(() => confirmMintsoftSupplierMapping({ supplierId: row.supplierId, externalSupplierId: picked[row.supplierId], source: 'OPERATOR_PICKED' }))}
                  >Map to this one</Button>
                  {(row.state !== 'CREATE_PENDING' || screen.createEnabled) && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={pending}
                      onClick={() => run(() => createMintsoftSupplierFromIms({ supplierId: row.supplierId }), row.supplierId)}
                    >{row.state === 'CREATE_PENDING' ? 'Send create now' : 'Create in Mintsoft'}</Button>
                  )}
                </div>
                {similar[row.supplierId] && (
                  <div className="space-y-1 rounded border border-amber-500 p-2 text-xs">
                    <div>Mintsoft already holds similar suppliers: {similar[row.supplierId]!.duplicates.map((d) => `${d.name} (${d.score}%${d.active ? '' : ', inactive'})`).join(', ')}. Map one of them, or create anyway:</div>
                    <div className="flex flex-wrap items-center gap-2">
                      <input
                        aria-label={`Create anyway reason for ${row.name}`}
                        className="min-w-64 rounded border bg-background px-2 py-1"
                        placeholder="Why none of these is the same supplier"
                        value={similar[row.supplierId]!.reason}
                        onChange={(event) => setSimilar((current) => ({ ...current, [row.supplierId]: { duplicates: current[row.supplierId]?.duplicates ?? [], reason: event.target.value } }))}
                      />
                      <Button type="button" size="sm" variant="outline" disabled={pending}
                        onClick={() => run(() => createMintsoftSupplierFromIms({ supplierId: row.supplierId, createAnyway: { reason: similar[row.supplierId]?.reason ?? '' } }), row.supplierId)}
                      >Create anyway</Button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </Card>
        ))}
      </div>
    </div>
  )
}

function ageText(iso: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000))
  if (minutes < 60) return `${minutes} min`
  const hours = Math.round(minutes / 60)
  return hours < 48 ? `${hours} h` : `${Math.round(hours / 24)} days`
}

function SwitchesForm({ screen, disabled, onSave }: { screen: SupplierMappingScreen; disabled: boolean; onSave: (value: { createEnabled: boolean; asnRequired: boolean; sendSupplierEnabled: boolean }) => void }) {
  const [createEnabled, setCreateEnabled] = useState(screen.createEnabled)
  const [asnRequired, setAsnRequired] = useState(screen.asnRequired)
  const [sendSupplierEnabled, setSendSupplierEnabled] = useState(screen.sendSupplierEnabled)
  return (
    <div className="space-y-2 text-sm">
      <label className="flex items-start gap-2">
        <input type="checkbox" checked={sendSupplierEnabled} onChange={(event) => { setSendSupplierEnabled(event.target.checked); if (!event.target.checked) setAsnRequired(false) }} />
        <span>Send the mapped supplier on an ASN (<code>mintsoft_asn_send_supplier_enabled</code>). Off: an ASN is exactly what it was before suppliers existed, even for a mapped supplier. Turn on ONLY after controlled-run step 2 (one ASN with <code>ProductSupplierId</code> on stage, read back) has verified the field.</span>
      </label>
      <label className="flex items-start gap-2">
        <input type="checkbox" checked={asnRequired} disabled={!sendSupplierEnabled} onChange={(event) => setAsnRequired(event.target.checked)} />
        <span>Refuse to create an ASN when its supplier is not mapped (<code>mintsoft_asn_supplier_required</code>; needs the switch above). Off: ASNs are created as before. This must be on before step M, once every active supplier and the transfer supplier are mapped.</span>
      </label>
      <label className="flex items-start gap-2">
        <input type="checkbox" checked={createEnabled} onChange={(event) => setCreateEnabled(event.target.checked)} />
        <span>Allow &quot;Create in Mintsoft&quot; to send (<code>mintsoft_supplier_create_enabled</code>). Off: the choice is recorded as pending and nothing is sent. Creating is a real write to Mintsoft and follows the producer hold.</span>
      </label>
      <Button type="button" size="sm" disabled={disabled || !screen.viewerIsAdmin} onClick={() => onSave({ createEnabled, asnRequired, sendSupplierEnabled })}>Save switches</Button>
      {!screen.viewerIsAdmin && <span className="ml-2 text-xs text-muted-foreground">Administrators only.</span>}
    </div>
  )
}
