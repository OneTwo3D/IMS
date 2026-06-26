'use client'

import { useEffect, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { AlertTriangle, Check, Loader2, Plus, RefreshCw, Settings2, Trash2 } from 'lucide-react'
import {
  confirmMintsoftAlignmentMode,
  deleteMintsoftBinding,
  restockMintsoftReturnInboxItem,
  runMintsoftBundleVerifyNow,
  runMintsoftProductVerifyNow,
  runMintsoftReturnsSyncNow,
  runMintsoftStockSyncNow,
  saveMintsoftBinding,
  saveMintsoftConnectionSettings,
  testMintsoftConnection,
  updateMintsoftReturnInboxStatus,
  type MintsoftDashboardData,
} from '@/app/actions/mintsoft-sync'
import { ProductLink } from '@/components/inventory/product-link'
import { useFormatDateTime } from '@/components/providers/timezone-provider'
import { Button } from '@/components/ui/button'
import { useStepUpReauth, isFreshAuthFailure, type MaybeFreshAuthFailure } from '@/components/auth/use-step-up-reauth'
import { Card } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { MintsoftCourierMapSection } from './mintsoft-courier-map'
import { Textarea } from '@/components/ui/textarea'

type Props = {
  data: MintsoftDashboardData
}

const RECEIPT_REVIEW_WARNING_LABELS: Record<string, string> = {
  cost_layer_snapshot_missing: 'Cost-layer snapshot missing',
  missing_local_line: 'IMS line missing',
  received_over_expected: 'Over-received',
  remote_regression: 'Mintsoft quantity decreased',
  unsupported_source_type: 'Unsupported source line',
}

const RECEIPT_REVIEW_BLOCKING_WARNINGS = new Set([
  'cost_layer_snapshot_missing',
  'missing_local_line',
  'remote_regression',
  'unsupported_source_type',
])

function formatThresholdSummary(
  thresholds: { absoluteDelta: number | null; percentDelta: number | null } | null,
): string {
  if (!thresholds) return 'Default'
  const parts: string[] = []
  if (thresholds.absoluteDelta != null) parts.push(`Abs ${thresholds.absoluteDelta}`)
  if (thresholds.percentDelta != null) parts.push(`${thresholds.percentDelta}%`)
  return parts.length > 0 ? parts.join(' / ') : 'Default'
}

function EnvOverrideNotice({ overrides }: { overrides: Record<string, string> }) {
  const entries = Object.entries(overrides)
  if (entries.length === 0) return null

  return (
    <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
      <div className="flex gap-2">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-none" />
        <span>
          {entries.map(([settingKey, envKey]) => `${settingKey} is overridden by ${envKey}`).join('; ')}.
          {' '}Clear the environment variable to apply changes saved here.
        </span>
      </div>
    </div>
  )
}

function ReceiptReviewWarnings({ warnings }: { warnings: string[] }) {
  if (warnings.length === 0) return <span className="text-muted-foreground">Review required</span>

  return (
    <div className="flex flex-wrap gap-1">
      {warnings.map((warning) => {
        const blocking = RECEIPT_REVIEW_BLOCKING_WARNINGS.has(warning)
        return (
          <span
            key={warning}
            className={
              blocking
                ? 'rounded border border-red-200 bg-red-50 px-1.5 py-0.5 text-[11px] font-medium text-red-700'
                : 'rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[11px] font-medium text-amber-700'
            }
          >
            {RECEIPT_REVIEW_WARNING_LABELS[warning] ?? warning}
          </span>
        )
      })}
    </div>
  )
}

export function MintsoftClient({ data }: Props) {
  const formatDateTime = useFormatDateTime()
  const router = useRouter()
  const { promptReauth, stepUpDialog } = useStepUpReauth()

  // audit-ohou: step-up re-auth + retry once on the fresh_auth_required failure.
  async function withStepUp<T extends MaybeFreshAuthFailure>(run: () => Promise<T>): Promise<T> {
    const result = await run()
    if (isFreshAuthFailure(result) && (await promptReauth())) {
      return run()
    }
    return result
  }

  const [isPending, startTransition] = useTransition()
  const savedTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const defaultWarehouseId = data.warehouses.find((warehouse) => warehouse.active)?.id ?? ''
  const defaultExternalWarehouseId = data.externalWarehouses[0]?.externalId ?? ''
  const [isConnectionDialogOpen, setIsConnectionDialogOpen] = useState(false)
  const [isBindingDialogOpen, setIsBindingDialogOpen] = useState(false)
  const [isRestockDialogOpen, setIsRestockDialogOpen] = useState(false)
  const [label, setLabel] = useState(data.connection.label)
  const [baseUrl, setBaseUrl] = useState(data.connection.baseUrl)
  const [username, setUsername] = useState(data.connection.username)
  const [password, setPassword] = useState('')
  const [webhookSecret, setWebhookSecret] = useState('')
  const [orderLookupConnector, setOrderLookupConnector] = useState(data.connection.orderLookupConnector)
  const [active, setActive] = useState(data.connection.active ? 'true' : 'false')
  const [bindingActive, setBindingActive] = useState('true')
  const [warehouseId, setWarehouseId] = useState(defaultWarehouseId)
  const [externalWarehouseId, setExternalWarehouseId] = useState(defaultExternalWarehouseId)
  const [stockSyncMode, setStockSyncMode] = useState<'DISABLED' | 'NOTIFICATION_ONLY' | 'ALIGN_TO_WMS'>('NOTIFICATION_ONLY')
  const [bundleSyncDirection, setBundleSyncDirection] = useState<'DISABLED' | 'IMS_TO_WMS' | 'WMS_TO_IMS'>('DISABLED')
  const [returnsMode, setReturnsMode] = useState<'DISABLED' | 'POLL' | 'WEBHOOK'>('DISABLED')
  const [syncFrequencyMinutes, setSyncFrequencyMinutes] = useState('60')
  const [absoluteDelta, setAbsoluteDelta] = useState('')
  const [percentDelta, setPercentDelta] = useState('')
  const [reportRecipients, setReportRecipients] = useState('')
  const [restockItemId, setRestockItemId] = useState('')
  const [restockItemSku, setRestockItemSku] = useState('')
  const [restockWarehouseId, setRestockWarehouseId] = useState(defaultWarehouseId)
  const [error, setError] = useState('')
  const [feedbackMessage, setFeedbackMessage] = useState('')
  const [saved, setSaved] = useState(false)
  const [testingConnection, setTestingConnection] = useState(false)
  const orderLookupConnectorRequired = data.orderLookupConnectorRequired

  useEffect(() => {
    return () => {
      if (savedTimeoutRef.current) clearTimeout(savedTimeoutRef.current)
    }
  }, [])

  function flashSaved(message: string) {
    setFeedbackMessage(message)
    setSaved(true)
    if (savedTimeoutRef.current) clearTimeout(savedTimeoutRef.current)
    savedTimeoutRef.current = setTimeout(() => setSaved(false), 3000)
  }

  function resetConnectionForm() {
    setLabel(data.connection.label)
    setBaseUrl(data.connection.baseUrl)
    setUsername(data.connection.username)
    setPassword('')
    setWebhookSecret('')
    setOrderLookupConnector(data.connection.orderLookupConnector)
    setActive(data.connection.active ? 'true' : 'false')
  }

  function resetBindingForm() {
    setBindingActive('true')
    setWarehouseId(defaultWarehouseId)
    setExternalWarehouseId(defaultExternalWarehouseId)
    setStockSyncMode('NOTIFICATION_ONLY')
    setBundleSyncDirection('DISABLED')
    setReturnsMode('DISABLED')
    setSyncFrequencyMinutes('60')
    setAbsoluteDelta('')
    setPercentDelta('')
    setReportRecipients('')
  }

  function handleConnectionDialogOpenChange(open: boolean) {
    if (open) resetConnectionForm()
    setIsConnectionDialogOpen(open)
    if (!open) resetConnectionForm()
  }

  function handleBindingDialogOpenChange(open: boolean) {
    if (open) resetBindingForm()
    setIsBindingDialogOpen(open)
    if (!open) resetBindingForm()
  }

  function handleRestockDialogOpenChange(open: boolean) {
    setIsRestockDialogOpen(open)
    if (!open) {
      setRestockItemId('')
      setRestockItemSku('')
      setRestockWarehouseId(defaultWarehouseId)
    }
  }

  function handleSaveConnection() {
    setError('')
    startTransition(async () => {
      const result = await withStepUp(() => saveMintsoftConnectionSettings({
        label,
        baseUrl,
        username,
        password,
        webhookSecret,
        orderLookupConnector,
        active: active === 'true',
      }))

      if (!result.success) {
        setError(result.error ?? 'Failed to save Mintsoft connection')
        return
      }

      handleConnectionDialogOpenChange(false)
      flashSaved(result.message ?? 'Connection verified with Mintsoft.')
      router.refresh()
    })
  }

  async function handleTestConnection() {
    setError('')
    setFeedbackMessage('')
    setTestingConnection(true)
    try {
      const result = await testMintsoftConnection({
        label,
        baseUrl,
        username,
        password,
        webhookSecret,
        orderLookupConnector,
        active: active === 'true',
      })

      if (!result.success) {
        setError(result.error ?? 'Mintsoft connection test failed.')
        return
      }

      flashSaved(result.message ?? 'Connection verified with Mintsoft.')
      router.refresh()
    } finally {
      setTestingConnection(false)
    }
  }

  function handleCreateBinding() {
    setError('')
    startTransition(async () => {
      const result = await saveMintsoftBinding({
        warehouseId,
        externalWarehouseId,
        active: bindingActive === 'true',
        stockSyncMode,
        bundleSyncDirection,
        returnsMode,
        syncFrequencyMinutes: Number.parseInt(syncFrequencyMinutes, 10) || 60,
        discrepancyThresholds: {
          absoluteDelta: absoluteDelta.trim() ? Number(absoluteDelta) : null,
          percentDelta: percentDelta.trim() ? Number(percentDelta) : null,
        },
        reportRecipients: reportRecipients
          .split(/[\n,]/)
          .map((recipient) => recipient.trim())
          .filter(Boolean),
      })

      if (!result.success) {
        setError(result.error ?? 'Failed to save Mintsoft binding')
        return
      }

      handleBindingDialogOpenChange(false)
      flashSaved('Mintsoft binding saved')
      router.refresh()
    })
  }

  function handleDeleteBinding(id: string) {
    setError('')
    startTransition(async () => {
      const result = await deleteMintsoftBinding(id)
      if (!result.success) {
        setError(result.error ?? 'Failed to deactivate Mintsoft binding')
        return
      }

      flashSaved('Mintsoft binding deactivated')
      router.refresh()
    })
  }

  function handleConfirmAlignment(bindingId: string) {
    setError('')
    startTransition(async () => {
      const result = await confirmMintsoftAlignmentMode(bindingId)
      if (!result.success) {
        setError(result.error ?? 'Failed to confirm alignment mode')
        return
      }

      router.refresh()
      flashSaved('Mintsoft alignment mode confirmed')
    })
  }

  function handleRunSyncNow(id: string) {
    setError('')
    startTransition(async () => {
      const result = await runMintsoftStockSyncNow(id)
      if (!result.success) {
        setError(result.error ?? 'Failed to run Mintsoft stock sync')
        return
      }

      flashSaved(result.message ?? 'Mintsoft stock sync started')
      router.refresh()
    })
  }

  function handleRunProductVerify() {
    setError('')
    startTransition(async () => {
      const result = await runMintsoftProductVerifyNow()
      if (!result.success) {
        setError(result.error ?? 'Failed to run Mintsoft product verify')
        return
      }

      flashSaved(result.message ?? 'Mintsoft product verify completed')
      router.refresh()
    })
  }

  function handleRunBundleVerify() {
    setError('')
    startTransition(async () => {
      const result = await runMintsoftBundleVerifyNow()
      if (!result.success) {
        setError(result.error ?? 'Failed to run Mintsoft bundle verify')
        return
      }

      flashSaved(result.message ?? 'Mintsoft bundle verify completed')
      router.refresh()
    })
  }

  function handleRunReturnsSync() {
    setError('')
    startTransition(async () => {
      const result = await runMintsoftReturnsSyncNow()
      if (!result.success) {
        setError(result.error ?? 'Failed to run Mintsoft returns sync')
        return
      }

      flashSaved(result.message ?? 'Mintsoft returns sync completed')
      router.refresh()
    })
  }

  function handleUpdateReturnStatus(id: string, status: 'UNDER_REVIEW' | 'QUARANTINED' | 'DISMISSED') {
    setError('')
    startTransition(async () => {
      const result = await updateMintsoftReturnInboxStatus(id, status)
      if (!result.success) {
        setError(result.error ?? 'Failed to update Mintsoft return inbox item')
        return
      }

      flashSaved(`Return marked ${status.toLowerCase().replace(/_/g, ' ')}`)
      router.refresh()
    })
  }

  function handleOpenRestockDialog(item: { id: string; sku: string | null; warehouseCode: string | null }) {
    setRestockItemId(item.id)
    setRestockItemSku(item.sku ?? '')
    const matchingWarehouse = data.warehouses.find((warehouse) => warehouse.code === item.warehouseCode && warehouse.active)
    setRestockWarehouseId(matchingWarehouse?.id ?? data.warehouses.find((warehouse) => warehouse.active)?.id ?? '')
    setIsRestockDialogOpen(true)
  }

  function handleRestockReturn() {
    setError('')
    startTransition(async () => {
      const result = await restockMintsoftReturnInboxItem({
        id: restockItemId,
        warehouseId: restockWarehouseId,
      })
      if (!result.success) {
        setError(result.error ?? 'Failed to restock Mintsoft return')
        return
      }

      handleRestockDialogOpenChange(false)
      flashSaved(result.message ?? 'Mintsoft return restocked')
      router.refresh()
    })
  }

  return (
    <div className="space-y-6">
      {stepUpDialog}
      <Card className="p-6 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-base font-semibold">Connection</h3>
            <p className="text-sm text-muted-foreground">
              Configure Mintsoft credentials, resolve callback order lookup, and run Mintsoft warehouse and product verification from one place.
            </p>
          </div>
          <Button type="button" variant="outline" onClick={() => handleConnectionDialogOpenChange(true)} disabled={isPending}>
            <Settings2 className="mr-2 h-4 w-4" />
            Edit Connection
          </Button>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-lg border bg-muted/20 p-3">
            <div className="text-xs text-muted-foreground">Status</div>
            <div className="mt-1 text-sm font-medium">
              {data.status.configured ? 'Configured' : 'Not configured'}
            </div>
          </div>
          <div className="rounded-lg border bg-muted/20 p-3">
            <div className="text-xs text-muted-foreground">Connection State</div>
            <div className="mt-1 text-sm font-medium">{data.connection.active ? 'Active' : 'Disabled'}</div>
          </div>
          <div className="rounded-lg border bg-muted/20 p-3">
            <div className="text-xs text-muted-foreground">Order Lookup</div>
            <div className="mt-1 text-sm font-medium">{data.connection.orderLookupConnector || 'Unset'}</div>
          </div>
          <div className="rounded-lg border bg-muted/20 p-3">
            <div className="text-xs text-muted-foreground">Warehouse Bindings</div>
            <div className="mt-1 text-sm font-medium">
              {data.status.bindingCount} binding{data.status.bindingCount === 1 ? '' : 's'}
            </div>
          </div>
        </div>

        <div className="rounded-lg border bg-muted/30 p-3 text-xs text-muted-foreground">
          Webhook endpoint: <code>/api/webhooks/mintsoft/asn-booked-in</code>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" onClick={handleRunProductVerify} disabled={isPending || !data.status.configured}>
            <RefreshCw className="mr-2 h-4 w-4" />
            Run Product Verify
          </Button>
          <Button type="button" variant="outline" onClick={handleRunBundleVerify} disabled={isPending || !data.status.configured}>
            <RefreshCw className="mr-2 h-4 w-4" />
            Run Bundle Verify
          </Button>
          <Button type="button" variant="outline" onClick={handleRunReturnsSync} disabled={isPending || !data.status.configured}>
            <RefreshCw className="mr-2 h-4 w-4" />
            Poll Returns
          </Button>
        </div>

        {data.warehouseLookupError ? (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
            Mintsoft warehouse lookup failed: {data.warehouseLookupError}
          </div>
        ) : null}
      </Card>

      <MintsoftCourierMapSection />

      <Card className="p-6 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-base font-semibold">Warehouse Bindings</h3>
            <p className="text-sm text-muted-foreground">
              Notification-only keeps IMS as stock master. Align To WMS is align-up only and requires a completed dry run before live corrections are allowed.
            </p>
          </div>
          <Button type="button" onClick={() => handleBindingDialogOpenChange(true)} disabled={isPending}>
            <Plus className="mr-2 h-4 w-4" />
            Add Binding
          </Button>
        </div>

        <Table containerClassName="rounded-lg border max-h-[40vh]" className="min-w-[900px]">
          <TableHeader className="bg-muted/40">
            <TableRow>
              <TableHead>Warehouse</TableHead>
              <TableHead>Mintsoft Warehouse</TableHead>
              <TableHead>Mode</TableHead>
              <TableHead>Thresholds</TableHead>
              <TableHead>Recipients</TableHead>
              <TableHead>Last Sync</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.bindings.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="py-6 text-center text-muted-foreground">
                  No Mintsoft warehouse bindings yet.
                </TableCell>
              </TableRow>
            ) : (
              data.bindings.map((binding) => (
                <TableRow key={binding.id} className={!binding.active ? 'opacity-60' : ''}>
                  <TableCell>
                    <div className="font-medium">{binding.warehouseCode}</div>
                    <div className="text-xs text-muted-foreground">{binding.warehouseName}</div>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{binding.externalWarehouseId}</TableCell>
                  <TableCell>
                    <div className="text-sm">{binding.stockSyncMode}</div>
                    <div className="text-xs text-muted-foreground">
                      {binding.stockMasterSystem}
                      {binding.stockSyncMode === 'ALIGN_TO_WMS' && !binding.alignmentConfirmedAt ? ' · Dry run only' : ''}
                      {binding.stockSyncMode === 'ALIGN_TO_WMS' ? ' · Align up only' : ''}
                    </div>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {formatThresholdSummary(binding.discrepancyThresholds)}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {binding.reportRecipients.length > 0 ? binding.reportRecipients.join(', ') : 'None'}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{binding.lastStockSyncAt ?? 'Never'}</TableCell>
                  <TableCell className="text-xs">
                    <span className="font-medium">{binding.lastStockSyncStatus ?? (binding.active ? 'Idle' : 'Inactive')}</span>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => handleConfirmAlignment(binding.id)}
                        disabled={isPending || !binding.active || binding.stockSyncMode !== 'ALIGN_TO_WMS' || !!binding.alignmentConfirmedAt || !binding.alignmentDryRunReady}
                      >
                        <Check className="h-4 w-4" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => handleRunSyncNow(binding.id)}
                        disabled={isPending || !binding.active || binding.stockSyncMode === 'DISABLED'}
                      >
                        <RefreshCw className="h-4 w-4" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => handleDeleteBinding(binding.id)}
                        disabled={isPending || !binding.active}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>

      <Card className="p-6 space-y-4">
        <div>
          <h3 className="text-base font-semibold">Recent Stock Sync Runs</h3>
          <p className="text-sm text-muted-foreground">
            Latest notification-only sync jobs recorded for Mintsoft warehouse bindings.
          </p>
        </div>

        <Table containerClassName="rounded-lg border max-h-[40vh]">
          <TableHeader className="bg-muted/40">
            <TableRow>
              <TableHead>Started</TableHead>
              <TableHead>Warehouse</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Checked</TableHead>
              <TableHead>Discrepancies</TableHead>
              <TableHead>Errors</TableHead>
              <TableHead>Triggered By</TableHead>
              <TableHead className="text-right">Export</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.recentStockSyncJobs.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="py-6 text-center text-muted-foreground">
                  No Mintsoft stock sync jobs yet.
                </TableCell>
              </TableRow>
            ) : (
              data.recentStockSyncJobs.map((job) => (
                <TableRow key={job.id}>
                  <TableCell className="text-xs text-muted-foreground">{job.startedAt}</TableCell>
                  <TableCell>{job.warehouseCode ?? 'N/A'}</TableCell>
                  <TableCell className="font-medium">{job.status}</TableCell>
                  <TableCell>{job.totalChecked}</TableCell>
                  <TableCell>{job.mismatched}</TableCell>
                  <TableCell>{job.errors}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{job.triggeredBy ?? 'system'}</TableCell>
                  <TableCell className="text-right">
                    <a
                      href={`/api/export/mintsoft-sync/${job.id}`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs text-primary hover:underline"
                    >
                      CSV
                    </a>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>

      <Card className="p-6 space-y-4">
        <div>
          <h3 className="text-base font-semibold">Open Discrepancies</h3>
          <p className="text-sm text-muted-foreground">
            The current notification backlog surfaced by Mintsoft stock snapshots.
          </p>
        </div>

        <Table containerClassName="rounded-lg border max-h-[40vh]">
          <TableHeader className="bg-muted/40">
            <TableRow>
              <TableHead>Warehouse</TableHead>
              <TableHead>Product</TableHead>
              <TableHead>Category</TableHead>
              <TableHead>IMS</TableHead>
              <TableHead>WMS</TableHead>
              <TableHead>Delta</TableHead>
              <TableHead>Seen</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.openDiscrepancies.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="py-6 text-center text-muted-foreground">
                  No open Mintsoft discrepancies.
                </TableCell>
              </TableRow>
            ) : (
              data.openDiscrepancies.map((discrepancy) => (
                <TableRow key={discrepancy.id}>
                  <TableCell>{discrepancy.warehouseCode}</TableCell>
                  <TableCell>
                    {discrepancy.productId ? (
                      <ProductLink productId={discrepancy.productId} sku={discrepancy.sku} name={discrepancy.productName ?? ''} />
                    ) : (
                      <div>
                        <div className="font-mono text-sm font-medium">{discrepancy.sku}</div>
                        <div className="text-xs text-muted-foreground">{discrepancy.productName ?? 'Unmapped SKU'}</div>
                      </div>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="text-sm">{discrepancy.category}</div>
                    {discrepancy.message ? (
                      <div className="text-xs text-muted-foreground">{discrepancy.message}</div>
                    ) : null}
                  </TableCell>
                  <TableCell>{discrepancy.imsValue ?? '—'}</TableCell>
                  <TableCell>{discrepancy.wmsValue ?? '—'}</TableCell>
                  <TableCell>{discrepancy.delta ?? '—'}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{discrepancy.lastSeenAt}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>

      <Card className="p-6 space-y-4">
        <div>
          <h3 className="text-base font-semibold">Bundles</h3>
          <p className="text-sm text-muted-foreground">
            Linked Mintsoft bundles for IMS KIT products. Composition drift is surfaced in Open Discrepancies as{' '}
            <code className="rounded bg-muted px-1">BUNDLE_DERIVATION_CONFLICT</code> — Mintsoft has no bundle update API, so changes after the first push must be resolved manually.
          </p>
        </div>

        <Table containerClassName="rounded-lg border max-h-[40vh]" className="min-w-[720px]">
          <TableHeader className="bg-muted/40">
            <TableRow>
              <TableHead>Product</TableHead>
              <TableHead>Mintsoft Bundle ID</TableHead>
              <TableHead>Checksum</TableHead>
              <TableHead>Last Synced</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.bundleLinks.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4} className="py-6 text-center text-muted-foreground">
                  No Mintsoft bundles have been pushed yet.
                </TableCell>
              </TableRow>
            ) : (
              data.bundleLinks.map((link) => (
                <TableRow key={link.id}>
                  <TableCell>
                    <ProductLink productId={link.productId} sku={link.sku} name={link.name} />
                  </TableCell>
                  <TableCell className="font-mono text-xs">{link.externalBundleId}</TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {link.checksum ? `${link.checksum.slice(0, 12)}…` : '—'}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {link.lastSyncedAt ? formatDateTime(link.lastSyncedAt) : '—'}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>

      <Card className="p-6 space-y-4">
        <div>
          <h3 className="text-base font-semibold">Receipt Reviews</h3>
          <p className="text-sm text-muted-foreground">
            {data.receiptReviewEventCount === data.receiptReviewEvents.length
              ? `${data.receiptReviewEventCount} Mintsoft booked-in callback${data.receiptReviewEventCount === 1 ? '' : 's'} paused before stock updates.`
              : `${data.receiptReviewEventCount} Mintsoft booked-in callbacks paused before stock updates; showing newest ${data.receiptReviewEvents.length}.`}
          </p>
        </div>

        <Table containerClassName="rounded-lg border max-h-[40vh]" className="min-w-[860px]">
          <TableHeader className="bg-muted/40">
            <TableRow>
              <TableHead>Received</TableHead>
              <TableHead>ASN</TableHead>
              <TableHead>Warnings</TableHead>
              <TableHead>Lines</TableHead>
              <TableHead>Error</TableHead>
              <TableHead className="text-right">Details</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.receiptReviewEvents.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="py-6 text-center text-muted-foreground">
                  No Mintsoft receipt callbacks require review.
                </TableCell>
              </TableRow>
            ) : (
              data.receiptReviewEvents.map((event) => (
                <TableRow key={event.id}>
                  <TableCell className="text-xs text-muted-foreground">
                    {formatDateTime(event.receivedAt)}
                  </TableCell>
                  <TableCell>
                    <div className="font-mono text-xs font-medium">{event.externalAsnId ?? 'Unmapped'}</div>
                    <div className="text-xs text-muted-foreground">{event.externalEventId}</div>
                  </TableCell>
                  <TableCell className="text-xs">
                    <ReceiptReviewWarnings warnings={event.warnings} />
                  </TableCell>
                  <TableCell>{event.lineCount}</TableCell>
                  <TableCell className="max-w-[260px] truncate text-xs text-muted-foreground">
                    {event.lastError ?? '—'}
                  </TableCell>
                  <TableCell className="text-right">
                    <a
                      href={`/api/admin/wms/receipt-events/${event.id}/review`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs text-primary hover:underline"
                    >
                      JSON
                    </a>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>

      <Card className="p-6 space-y-4">
        <div>
          <h3 className="text-base font-semibold">Returns Inbox</h3>
          <p className="text-sm text-muted-foreground">
            Mintsoft return events are staged here for operator review. This phase records and classifies the work item; it does not auto-restock inventory.
          </p>
        </div>

        <Table containerClassName="rounded-lg border max-h-[40vh]" className="min-w-[980px]">
          <TableHeader className="bg-muted/40">
            <TableRow>
              <TableHead>Return</TableHead>
              <TableHead>Order</TableHead>
              <TableHead>Product</TableHead>
              <TableHead>Qty</TableHead>
              <TableHead>Reason</TableHead>
              <TableHead>Warehouse</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.returnsInbox.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="py-6 text-center text-muted-foreground">
                  No Mintsoft returns staged yet.
                </TableCell>
              </TableRow>
            ) : (
              data.returnsInbox.map((item) => (
                <TableRow key={item.id}>
                  <TableCell>
                    <div className="font-mono text-xs font-medium">{item.externalReturnId}</div>
                    <div className="text-xs text-muted-foreground">{item.reference ?? 'No order reference'}</div>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {item.orderNumber ?? item.externalOrderNumber ?? 'Unmatched'}
                  </TableCell>
                  <TableCell>
                    {item.productId && item.sku ? (
                      <ProductLink productId={item.productId} sku={item.sku} name="" />
                    ) : (
                      <span className="font-mono text-xs">{item.sku ?? 'Unmatched SKU'}</span>
                    )}
                  </TableCell>
                  <TableCell>{item.qty ?? '—'}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{item.reason ?? '—'}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{item.warehouseCode ?? 'Unmatched'}</TableCell>
                  <TableCell className="text-xs">
                    <div className="font-medium">{item.status}</div>
                    <div className="text-muted-foreground">{item.receivedAt ?? item.updatedAt}</div>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => handleUpdateReturnStatus(item.id, 'UNDER_REVIEW')}
                        disabled={isPending || item.status === 'UNDER_REVIEW' || item.status === 'RESTOCKED'}
                      >
                        Review
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => handleOpenRestockDialog(item)}
                        disabled={isPending || item.status === 'RESTOCKED' || !item.productId || !item.qty}
                      >
                        Restock
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => handleUpdateReturnStatus(item.id, 'QUARANTINED')}
                        disabled={isPending || item.status === 'QUARANTINED' || item.status === 'RESTOCKED'}
                      >
                        Quarantine
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => handleUpdateReturnStatus(item.id, 'DISMISSED')}
                        disabled={isPending || item.status === 'DISMISSED' || item.status === 'RESTOCKED'}
                      >
                        Dismiss
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>

      {saved ? (
        <span className="inline-flex items-center gap-1 text-sm text-green-600">
          <Check className="h-4 w-4" />
          {feedbackMessage}
        </span>
      ) : null}
      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      <Dialog open={isConnectionDialogOpen} onOpenChange={handleConnectionDialogOpenChange}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Edit Mintsoft Connection</DialogTitle>
            <DialogDescription>
              Save the Mintsoft login credentials used to renew Mintsoft&apos;s 24-hour API key and choose which shopping connector should resolve callback order numbers.
            </DialogDescription>
          </DialogHeader>
          <EnvOverrideNotice overrides={data.connection.envOverrides} />

          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label className="text-xs">Label</Label>
              <Input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Mintsoft WMS" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Base URL</Label>
              <Input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://api.mintsoft.co.uk/" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Username</Label>
              <Input
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                placeholder="Mintsoft username"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Password</Label>
              <Input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder={data.connection.passwordMasked ? '••••••••' : 'Mintsoft password'}
              />
              <p className="text-xs text-muted-foreground">
                Mintsoft uses these credentials to renew the 24-hour API key automatically.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Webhook Secret</Label>
              <Input
                type="password"
                value={webhookSecret}
                onChange={(event) => setWebhookSecret(event.target.value)}
                placeholder={data.connection.webhookSecretMasked ? '••••••••' : 'Shared secret'}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Order Lookup Connector</Label>
              <Select value={orderLookupConnector} onChange={(event) => setOrderLookupConnector(event.target.value as '' | 'woocommerce' | 'shopify')}>
                <option value="">None</option>
                {data.availableOrderLookupConnectors.includes('woocommerce') ? (
                  <option value="woocommerce">WooCommerce</option>
                ) : null}
                {data.availableOrderLookupConnectors.includes('shopify') ? (
                  <option value="shopify">Shopify</option>
                ) : null}
              </Select>
              <p className="text-xs text-muted-foreground">
                {orderLookupConnectorRequired
                  ? 'Required because more than one shopping connector is enabled.'
                  : 'Used to resolve storefront order numbers on Mintsoft callbacks.'}
              </p>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Connection State</Label>
              <Select value={active} onChange={(event) => setActive(event.target.value)}>
                <option value="true">Active</option>
                <option value="false">Disabled</option>
              </Select>
            </div>
            {data.connection.connectionTest.status !== 'never' ? (
              <p className={`md:col-span-2 text-xs ${data.connection.connectionTest.status === 'success' ? 'text-green-600' : 'text-destructive'}`}>
                Last connection test: {data.connection.connectionTest.status === 'success' ? 'passed' : 'failed'}
                {data.connection.connectionTest.testedAt ? ` at ${formatDateTime(data.connection.connectionTest.testedAt)}` : ''}
                {data.connection.connectionTest.message ? ` — ${data.connection.connectionTest.message}` : ''}
              </p>
            ) : null}
          </div>

          <DialogFooter showCloseButton>
            <Button
              type="button"
              variant="outline"
              onClick={handleTestConnection}
              disabled={isPending || testingConnection || (orderLookupConnectorRequired && !orderLookupConnector)}
            >
              {testingConnection ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Test Connection
            </Button>
            <Button
              type="button"
              onClick={handleSaveConnection}
              disabled={isPending || testingConnection || (orderLookupConnectorRequired && !orderLookupConnector)}
            >
              {isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Save Connection
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={isBindingDialogOpen} onOpenChange={handleBindingDialogOpenChange}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Add Mintsoft Warehouse Binding</DialogTitle>
            <DialogDescription>
              Create a notification-only Mintsoft warehouse binding with discrepancy thresholds and in-app notification recipients.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label className="text-xs">IMS Warehouse</Label>
              <Select value={warehouseId} onChange={(event) => setWarehouseId(event.target.value)}>
                <option value="">Select a warehouse</option>
                {data.warehouses.map((warehouse) => (
                  <option key={warehouse.id} value={warehouse.id}>
                    {warehouse.code} · {warehouse.name}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Connection State</Label>
              <Select value={bindingActive} onChange={(event) => setBindingActive(event.target.value)}>
                <option value="true">Active</option>
                <option value="false">Disabled</option>
              </Select>
            </div>
            <div className="space-y-1.5 md:col-span-2">
              <Label className="text-xs">Mintsoft Warehouse</Label>
              {data.externalWarehouses.length > 0 ? (
                <Select value={externalWarehouseId} onChange={(event) => setExternalWarehouseId(event.target.value)}>
                  <option value="">Select a Mintsoft warehouse</option>
                  {data.externalWarehouses.map((warehouse) => (
                    <option key={warehouse.externalId} value={warehouse.externalId}>
                      {warehouse.name} · {warehouse.externalId}
                    </option>
                  ))}
                </Select>
              ) : (
                <Input
                  value={externalWarehouseId}
                  onChange={(event) => setExternalWarehouseId(event.target.value)}
                  placeholder="External warehouse ID"
                />
              )}
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Stock Sync Mode</Label>
              <Select value={stockSyncMode} onChange={(event) => setStockSyncMode(event.target.value as 'DISABLED' | 'NOTIFICATION_ONLY' | 'ALIGN_TO_WMS')}>
                <option value="DISABLED">Disabled</option>
                <option value="NOTIFICATION_ONLY">Notification Only</option>
                <option value="ALIGN_TO_WMS">Align To WMS</option>
              </Select>
              <p className="text-xs text-muted-foreground">
                Stock master: {stockSyncMode === 'ALIGN_TO_WMS' ? 'WMS for upward corrections only (first sync is a dry run until confirmed)' : 'IMS'}
              </p>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Bundle Sync</Label>
              <Select
                value={bundleSyncDirection}
                onChange={(event) =>
                  setBundleSyncDirection(event.target.value as 'DISABLED' | 'IMS_TO_WMS' | 'WMS_TO_IMS')
                }
              >
                <option value="DISABLED">Disabled</option>
                <option value="IMS_TO_WMS">IMS → Mintsoft (push new KIT bundles)</option>
                <option value="WMS_TO_IMS">Mintsoft → IMS (verify only)</option>
              </Select>
              <p className="text-xs text-muted-foreground">
                Mintsoft bundles are create-only — composition changes after the first push raise a discrepancy.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Returns Mode</Label>
              <Select value={returnsMode} onChange={(event) => setReturnsMode(event.target.value as 'DISABLED' | 'POLL' | 'WEBHOOK')}>
                <option value="DISABLED">Disabled</option>
                <option value="POLL">Poll</option>
                <option value="WEBHOOK" disabled>
                  Webhook (Coming Later)
                </option>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Sync Frequency Minutes</Label>
              <Input
                type="number"
                min="1"
                value={syncFrequencyMinutes}
                onChange={(event) => setSyncFrequencyMinutes(event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Absolute Delta Threshold</Label>
              <Input
                type="number"
                min="0"
                step="0.0001"
                value={absoluteDelta}
                onChange={(event) => setAbsoluteDelta(event.target.value)}
                placeholder="e.g. 5"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Percent Delta Threshold</Label>
              <Input
                type="number"
                min="0"
                step="0.01"
                value={percentDelta}
                onChange={(event) => setPercentDelta(event.target.value)}
                placeholder="e.g. 10"
              />
            </div>
            <div className="space-y-1.5 md:col-span-2">
              <Label className="text-xs">Report Recipients</Label>
              <Textarea
                value={reportRecipients}
                onChange={(event) => setReportRecipients(event.target.value)}
                placeholder="Comma or newline separated user emails"
                rows={4}
              />
              <p className="text-xs text-muted-foreground">
                Matching IMS users will receive in-app warnings when a discrepancy exceeds the configured threshold.
              </p>
            </div>
          </div>

          <DialogFooter showCloseButton>
            <Button
              type="button"
              onClick={handleCreateBinding}
              disabled={isPending || !warehouseId || !externalWarehouseId.trim()}
            >
              {isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Add Warehouse Binding
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={isRestockDialogOpen} onOpenChange={handleRestockDialogOpenChange}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Restock Mintsoft Return</DialogTitle>
            <DialogDescription>
              Choose which warehouse should receive the returned stock for {restockItemSku || 'this product'}.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-1.5">
            <Label className="text-xs">Restock Warehouse</Label>
            <Select value={restockWarehouseId} onChange={(event) => setRestockWarehouseId(event.target.value)}>
              <option value="">Select a warehouse</option>
              {data.warehouses
                .filter((warehouse) => warehouse.active)
                .map((warehouse) => (
                  <option key={warehouse.id} value={warehouse.id}>
                    {warehouse.code} · {warehouse.name}
                  </option>
                ))}
            </Select>
          </div>

          <DialogFooter showCloseButton>
            <Button
              type="button"
              onClick={handleRestockReturn}
              disabled={isPending || !restockItemId || !restockWarehouseId}
            >
              {isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Confirm Restock
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
