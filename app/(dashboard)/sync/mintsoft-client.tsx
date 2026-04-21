'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Check, Loader2, Trash2 } from 'lucide-react'
import { saveMintsoftBinding, saveMintsoftConnectionSettings, deleteMintsoftBinding, type MintsoftDashboardData } from '@/app/actions/mintsoft-sync'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'

type Props = {
  data: MintsoftDashboardData
}

export function MintsoftClient({ data }: Props) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [label, setLabel] = useState(data.connection.label)
  const [baseUrl, setBaseUrl] = useState(data.connection.baseUrl)
  const [apiKey, setApiKey] = useState('')
  const [webhookSecret, setWebhookSecret] = useState('')
  const [orderLookupConnector, setOrderLookupConnector] = useState(data.connection.orderLookupConnector)
  const [active, setActive] = useState(data.connection.active ? 'true' : 'false')
  const [warehouseId, setWarehouseId] = useState(data.warehouses.find((warehouse) => warehouse.active)?.id ?? '')
  const [externalWarehouseId, setExternalWarehouseId] = useState('')
  const [stockSyncMode, setStockSyncMode] = useState('NOTIFICATION_ONLY')
  const [returnsMode, setReturnsMode] = useState('DISABLED')
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
        stockSyncMode: stockSyncMode as 'DISABLED' | 'NOTIFICATION_ONLY',
        returnsMode: returnsMode as 'DISABLED' | 'POLL' | 'WEBHOOK',
        syncFrequencyMinutes: Number.parseInt(syncFrequencyMinutes, 10) || 60,
      })

      if (!result.success) {
        setError(result.error ?? 'Failed to save Mintsoft binding')
        return
      }

      setExternalWarehouseId('')
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
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-base font-semibold">Connection</h3>
            <p className="text-sm text-muted-foreground">
              Save the Mintsoft API credentials and choose which shopping connector should resolve callback order numbers.
            </p>
          </div>
          <div className="text-sm text-muted-foreground">
            {data.status.configured ? 'Configured' : 'Not configured'} · {data.status.bindingCount} warehouse binding{data.status.bindingCount === 1 ? '' : 's'}
          </div>
        </div>

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

        <div className="rounded-lg border bg-muted/30 p-3 text-xs text-muted-foreground">
          Webhook endpoint: <code>/api/webhooks/mintsoft/asn-booked-in</code>
        </div>

        <div className="flex items-center gap-2">
          <Button
            type="button"
            onClick={handleSaveConnection}
            disabled={isPending || (orderLookupConnectorRequired && !orderLookupConnector)}
          >
            {isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Save Connection
          </Button>
          {saved ? (
            <span className="inline-flex items-center gap-1 text-sm text-green-600">
              <Check className="h-4 w-4" />
              Saved
            </span>
          ) : null}
        </div>
      </Card>

      <Card className="p-6 space-y-4">
        <div>
          <h3 className="text-base font-semibold">Warehouse Bindings</h3>
          <p className="text-sm text-muted-foreground">
            Link IMS warehouses to Mintsoft warehouse identifiers before stock alignment and returns processing are enabled.
          </p>
        </div>

        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
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
            <Select value={stockSyncMode} onChange={(event) => setStockSyncMode(event.target.value)}>
              <option value="DISABLED">Disabled</option>
              <option value="NOTIFICATION_ONLY">Notification Only</option>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Returns Mode</Label>
            <Select value={returnsMode} onChange={(event) => setReturnsMode(event.target.value)}>
              <option value="DISABLED">Disabled</option>
              <option value="POLL">Poll</option>
              <option value="WEBHOOK">Webhook</option>
            </Select>
          </div>
          <div className="space-y-1.5 md:col-span-2 xl:col-span-1">
            <Label className="text-xs">Sync Frequency Minutes</Label>
            <Input
              type="number"
              min="1"
              value={syncFrequencyMinutes}
              onChange={(event) => setSyncFrequencyMinutes(event.target.value)}
            />
          </div>
        </div>

        <Button type="button" onClick={handleCreateBinding} disabled={isPending || !warehouseId || !externalWarehouseId.trim()}>
          {isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
          Add Warehouse Binding
        </Button>

        <div className="rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-left">
              <tr>
                <th className="px-3 py-2 font-medium">Warehouse</th>
                <th className="px-3 py-2 font-medium">Mintsoft ID</th>
                <th className="px-3 py-2 font-medium">Stock Mode</th>
                <th className="px-3 py-2 font-medium">Returns</th>
                <th className="px-3 py-2 font-medium">Last Sync</th>
                <th className="px-3 py-2 font-medium text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {data.bindings.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-3 py-6 text-center text-muted-foreground">
                    No Mintsoft warehouse bindings yet.
                  </td>
                </tr>
              ) : (
                data.bindings.map((binding) => (
                  <tr key={binding.id} className="border-t">
                    <td className="px-3 py-2">
                      <div className="font-medium">{binding.warehouseCode}</div>
                      <div className="text-xs text-muted-foreground">{binding.warehouseName}</div>
                    </td>
                    <td className="px-3 py-2 font-mono text-xs">{binding.externalWarehouseId}</td>
                    <td className="px-3 py-2">{binding.stockSyncMode}</td>
                    <td className="px-3 py-2">{binding.returnsMode}</td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">
                      {binding.lastStockSyncAt ?? 'Never'}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => handleDeleteBinding(binding.id)}
                        disabled={isPending}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </div>
  )
}
