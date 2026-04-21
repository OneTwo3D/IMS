'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Check, Loader2, Plus, Settings2, Trash2 } from 'lucide-react'
import { deleteMintsoftBinding, saveMintsoftBinding, saveMintsoftConnectionSettings, type MintsoftDashboardData } from '@/app/actions/mintsoft-sync'
import { Button } from '@/components/ui/button'
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

type Props = {
  data: MintsoftDashboardData
}

export function MintsoftClient({ data }: Props) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [isConnectionDialogOpen, setIsConnectionDialogOpen] = useState(false)
  const [isBindingDialogOpen, setIsBindingDialogOpen] = useState(false)
  const [label, setLabel] = useState(data.connection.label)
  const [baseUrl, setBaseUrl] = useState(data.connection.baseUrl)
  const [apiKey, setApiKey] = useState('')
  const [webhookSecret, setWebhookSecret] = useState('')
  const [orderLookupConnector, setOrderLookupConnector] = useState(data.connection.orderLookupConnector)
  const [active, setActive] = useState(data.connection.active ? 'true' : 'false')
  const [warehouseId, setWarehouseId] = useState(data.warehouses.find((warehouse) => warehouse.active)?.id ?? '')
  const [externalWarehouseId, setExternalWarehouseId] = useState('')
  const [stockSyncMode, setStockSyncMode] = useState<'DISABLED' | 'NOTIFICATION_ONLY'>('NOTIFICATION_ONLY')
  const [returnsMode, setReturnsMode] = useState<'DISABLED' | 'POLL' | 'WEBHOOK'>('DISABLED')
  const [syncFrequencyMinutes, setSyncFrequencyMinutes] = useState('60')
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const orderLookupConnectorRequired = data.orderLookupConnectorRequired

  function flashSaved() {
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  function handleSaveConnection() {
    setError('')
    startTransition(async () => {
      const result = await saveMintsoftConnectionSettings({
        label,
        baseUrl,
        apiKey,
        webhookSecret,
        orderLookupConnector,
        active: active === 'true',
      })

      if (!result.success) {
        setError(result.error ?? 'Failed to save Mintsoft connection')
        return
      }

      setIsConnectionDialogOpen(false)
      flashSaved()
      router.refresh()
    })
  }

  function handleCreateBinding() {
    setError('')
    startTransition(async () => {
      const result = await saveMintsoftBinding({
        warehouseId,
        externalWarehouseId,
        stockSyncMode,
        returnsMode,
        syncFrequencyMinutes: Number.parseInt(syncFrequencyMinutes, 10) || 60,
      })

      if (!result.success) {
        setError(result.error ?? 'Failed to save Mintsoft binding')
        return
      }

      setExternalWarehouseId('')
      setStockSyncMode('NOTIFICATION_ONLY')
      setReturnsMode('DISABLED')
      setSyncFrequencyMinutes('60')
      setIsBindingDialogOpen(false)
      flashSaved()
      router.refresh()
    })
  }

  function handleDeleteBinding(id: string) {
    setError('')
    startTransition(async () => {
      const result = await deleteMintsoftBinding(id)
      if (!result.success) {
        setError(result.error ?? 'Failed to delete Mintsoft binding')
        return
      }

      flashSaved()
      router.refresh()
    })
  }

  return (
    <div className="space-y-6">
      <Card className="p-6 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-base font-semibold">Connection</h3>
            <p className="text-sm text-muted-foreground">
              Configure Mintsoft credentials and define how Mintsoft callbacks map back to storefront orders.
            </p>
          </div>
          <Button type="button" variant="outline" onClick={() => setIsConnectionDialogOpen(true)} disabled={isPending}>
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
      </Card>

      <Card className="p-6 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-base font-semibold">Warehouse Bindings</h3>
            <p className="text-sm text-muted-foreground">
              Link IMS warehouses to Mintsoft warehouse identifiers before stock alignment and returns processing are enabled.
            </p>
          </div>
          <Button type="button" onClick={() => setIsBindingDialogOpen(true)} disabled={isPending}>
            <Plus className="mr-2 h-4 w-4" />
            Add Binding
          </Button>
        </div>

        <Table containerClassName="rounded-lg border">
          <TableHeader className="bg-muted/40">
            <TableRow>
              <TableHead>Warehouse</TableHead>
              <TableHead>Mintsoft ID</TableHead>
              <TableHead>Stock Mode</TableHead>
              <TableHead>Returns</TableHead>
              <TableHead>Last Sync</TableHead>
              <TableHead className="text-right">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.bindings.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="py-6 text-center text-muted-foreground">
                  No Mintsoft warehouse bindings yet.
                </TableCell>
              </TableRow>
            ) : (
              data.bindings.map((binding) => (
                <TableRow key={binding.id}>
                  <TableCell>
                    <div className="font-medium">{binding.warehouseCode}</div>
                    <div className="text-xs text-muted-foreground">{binding.warehouseName}</div>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{binding.externalWarehouseId}</TableCell>
                  <TableCell>{binding.stockSyncMode}</TableCell>
                  <TableCell>{binding.returnsMode}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{binding.lastStockSyncAt ?? 'Never'}</TableCell>
                  <TableCell className="text-right">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => handleDeleteBinding(binding.id)}
                      disabled={isPending}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
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
          Saved
        </span>
      ) : null}
      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      <Dialog open={isConnectionDialogOpen} onOpenChange={setIsConnectionDialogOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Edit Mintsoft Connection</DialogTitle>
            <DialogDescription>
              Save the Mintsoft API credentials and choose which shopping connector should resolve callback order numbers.
            </DialogDescription>
          </DialogHeader>

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
              <Label className="text-xs">API Key</Label>
              <Input
                type="password"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder={data.connection.apiKeyMasked ? '••••••••' : 'Mintsoft API key'}
              />
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
          </div>

          <DialogFooter showCloseButton>
            <Button
              type="button"
              onClick={handleSaveConnection}
              disabled={isPending || (orderLookupConnectorRequired && !orderLookupConnector)}
            >
              {isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Save Connection
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={isBindingDialogOpen} onOpenChange={setIsBindingDialogOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Add Mintsoft Warehouse Binding</DialogTitle>
            <DialogDescription>
              Create a Mintsoft warehouse binding using the current supported stock and returns modes.
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
              <Label className="text-xs">Mintsoft Warehouse ID</Label>
              <Input
                value={externalWarehouseId}
                onChange={(event) => setExternalWarehouseId(event.target.value)}
                placeholder="External warehouse ID"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Stock Sync Mode</Label>
              <Select value={stockSyncMode} onChange={(event) => setStockSyncMode(event.target.value as 'DISABLED' | 'NOTIFICATION_ONLY')}>
                <option value="DISABLED">Disabled</option>
                <option value="NOTIFICATION_ONLY">Notification Only</option>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Returns Mode</Label>
              <Select value={returnsMode} onChange={(event) => setReturnsMode(event.target.value as 'DISABLED' | 'POLL' | 'WEBHOOK')}>
                <option value="DISABLED">Disabled</option>
                <option value="POLL">Poll</option>
                <option value="WEBHOOK">Webhook</option>
              </Select>
            </div>
            <div className="space-y-1.5 md:col-span-2">
              <Label className="text-xs">Sync Frequency Minutes</Label>
              <Input
                type="number"
                min="1"
                value={syncFrequencyMinutes}
                onChange={(event) => setSyncFrequencyMinutes(event.target.value)}
              />
            </div>
          </div>

          <DialogFooter showCloseButton>
            <Button type="button" onClick={handleCreateBinding} disabled={isPending || !warehouseId || !externalWarehouseId.trim()}>
              {isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Add Warehouse Binding
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
