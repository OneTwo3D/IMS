'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Boxes, Check, ExternalLink, Loader2 } from 'lucide-react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { saveMintsoftConnectionSettings } from '@/app/actions/mintsoft-sync'
import type { MaybeFreshAuthFailure } from '@/components/auth/use-step-up-reauth'
import type { MintsoftOnboardingConnectionData } from '@/app/actions/mintsoft-sync'
import type { WmsOnboardingConnectionData } from '@/app/actions/wms-onboarding'

type ShoppingLookupConnector = 'woocommerce' | 'shopify'

/**
 * Connector-agnostic WMS section of the onboarding integrations step: renders the
 * enable switch plus the active connector's connection form. This file is the WMS
 * connection-UI registry — add a connector by dispatching to its form below; the
 * integrations step and onboarding page stay generic.
 */

type Props = {
  data: WmsOnboardingConnectionData
  enabled: boolean
  busy: boolean
  availableOrderLookupConnectors: ShoppingLookupConnector[]
  withStepUp: <T extends MaybeFreshAuthFailure>(run: () => Promise<T>) => Promise<T>
  onToggle: (value: boolean) => void
  onBusyChange: (busy: boolean) => void
  onConnected: () => void
  onError: (message: string) => void
}

export function WmsOnboardingConnection({
  data,
  enabled,
  busy,
  availableOrderLookupConnectors,
  withStepUp,
  onToggle,
  onBusyChange,
  onConnected,
  onError,
}: Props) {
  return (
    <>
      <label className="flex items-start gap-3 cursor-pointer rounded-lg border p-3 hover:bg-muted/50 transition-colors">
        <Switch checked={enabled} onCheckedChange={onToggle} className="mt-0.5" disabled={busy} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <Boxes className="h-4 w-4 text-amber-600" />
            <span className="text-sm font-medium">{data.connectorLabel}</span>
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">
            Enable the {data.connectorLabel} WMS connector and warehouse binding tools
          </p>
        </div>
      </label>
      {enabled && data.connectorId === 'mintsoft' && data.mintsoft ? (
        <MintsoftConnectionForm
          data={data.mintsoft}
          connectorLabel={data.connectorLabel}
          busy={busy}
          availableOrderLookupConnectors={availableOrderLookupConnectors}
          withStepUp={withStepUp}
          onBusyChange={onBusyChange}
          onConnected={onConnected}
          onError={onError}
        />
      ) : null}
    </>
  )
}

type MintsoftFormProps = {
  data: MintsoftOnboardingConnectionData
  connectorLabel: string
  busy: boolean
  availableOrderLookupConnectors: ShoppingLookupConnector[]
  withStepUp: <T extends MaybeFreshAuthFailure>(run: () => Promise<T>) => Promise<T>
  onBusyChange: (busy: boolean) => void
  onConnected: () => void
  onError: (message: string) => void
}

function MintsoftConnectionForm({
  data,
  connectorLabel,
  busy,
  availableOrderLookupConnectors,
  withStepUp,
  onBusyChange,
  onConnected,
  onError,
}: MintsoftFormProps) {
  const router = useRouter()
  const [baseUrl, setBaseUrl] = useState(data.connection.baseUrl)
  const [username, setUsername] = useState(data.connection.username)
  const [password, setPassword] = useState(data.connection.passwordMasked ? '' : data.connection.password)
  const [webhookSecret, setWebhookSecret] = useState(data.connection.webhookSecretMasked ? '' : data.connection.webhookSecret)
  const [orderLookupConnector, setOrderLookupConnector] = useState(data.connection.orderLookupConnector)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [message, setMessage] = useState('')

  useEffect(() => {
    setBaseUrl(data.connection.baseUrl)
    setUsername(data.connection.username)
    setPassword(data.connection.passwordMasked ? '' : data.connection.password)
    setWebhookSecret(data.connection.webhookSecretMasked ? '' : data.connection.webhookSecret)
    setOrderLookupConnector(data.connection.orderLookupConnector)
  }, [data])

  useEffect(() => {
    function resetTransientBusyState() {
      setSaving(false)
      onBusyChange(false)
    }
    window.addEventListener('pageshow', resetTransientBusyState)
    return () => window.removeEventListener('pageshow', resetTransientBusyState)
  }, [onBusyChange])

  const orderLookupRequired = availableOrderLookupConnectors.length > 1
  const connected = saved || data.status.configured
  const connectedLabel = username.trim() || baseUrl.trim() || `${connectorLabel} account`

  function handleSave() {
    if (busy) return
    onError('')
    setSaved(false)
    setMessage('')
    setSaving(true)
    onBusyChange(true)
    void (async () => {
      try {
        const result = await withStepUp(() => saveMintsoftConnectionSettings({
          baseUrl,
          username,
          password,
          webhookSecret,
          orderLookupConnector,
          active: true,
        }))
        if (!result.success) {
          onError(result.error ?? `Failed to save ${connectorLabel} connection`)
          return
        }
        setSaved(true)
        setMessage(result.message ?? 'Connection verified and saved.')
        onConnected()
        router.refresh()
        setTimeout(() => setSaved(false), 2000)
      } catch (e) {
        onError(e instanceof Error ? e.message : `Failed to save ${connectorLabel} connection`)
      } finally {
        setSaving(false)
        onBusyChange(false)
      }
    })()
  }

  return (
    <Card className="p-4 space-y-4">
      {connected ? (
        <div className="flex items-center gap-2 rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-800">
          <Check className="h-4 w-4" />
          Connected to <strong>{connectedLabel}</strong>
        </div>
      ) : null}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="space-y-1.5 sm:col-span-2">
          <Label className="text-xs">Base URL</Label>
          <Input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://api.mintsoft.co.uk/"
            className="h-9"
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Username</Label>
          <Input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder={`${connectorLabel} username`}
            className="h-9"
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Password</Label>
          <Input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={data.connection.passwordMasked ? '••••••••' : `${connectorLabel} password`}
            className="h-9"
          />
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label className="text-xs">Webhook Secret</Label>
          <Input
            type="password"
            value={webhookSecret}
            onChange={(e) => setWebhookSecret(e.target.value)}
            placeholder={data.connection.webhookSecretMasked ? '••••••••' : 'Shared secret'}
            className="h-9"
          />
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label className="text-xs">Order Lookup Connector</Label>
          <select
            value={orderLookupConnector}
            onChange={(e) => setOrderLookupConnector(e.target.value as '' | 'woocommerce' | 'shopify')}
            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
          >
            <option value="">None</option>
            {availableOrderLookupConnectors.includes('woocommerce') ? <option value="woocommerce">WooCommerce</option> : null}
            {availableOrderLookupConnectors.includes('shopify') ? <option value="shopify">Shopify</option> : null}
          </select>
          <p className="text-xs text-muted-foreground">
            {orderLookupRequired
              ? 'Required because more than one shopping connector is enabled.'
              : availableOrderLookupConnectors.length === 0
                ? 'Optional. You can set this later after enabling a shopping connector.'
                : `Used to resolve storefront order numbers on ${connectorLabel} callbacks.`}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          onClick={handleSave}
          disabled={busy || (orderLookupRequired && !orderLookupConnector)}
          size="sm"
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
          {saved ? <><Check className="h-4 w-4 mr-1" />Verified</> : 'Save & Test Connection'}
        </Button>
        {message ? <span className="text-xs text-muted-foreground">{message}</span> : null}
        {data.status.configured ? (
          <span className="text-xs text-muted-foreground">{connectorLabel} connection is already configured.</span>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">
        Warehouse bindings and stock-sync rules are configured after onboarding in{' '}
        <Link href="/sync?connector=mintsoft" className="text-primary hover:underline inline-flex items-center gap-0.5">
          Integrations <ExternalLink className="h-3 w-3" />
        </Link>
        .
      </p>
    </Card>
  )
}
