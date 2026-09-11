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
import type { WmsConnectorId } from '@/lib/connectors/wms/types'

type ShoppingLookupConnector = 'woocommerce' | 'shopify'

/**
 * THE WMS CONNECTION-FORM REGISTRY — the onboarding wizard's setup step for whichever WMS
 * connector is active. Connector-agnostic above this file; connector-specific inside it.
 *
 * o3d-remove-shiphero round 6 (Codex HIGH 1) — WHY THIS IS A TOTAL RECORD AND NOT AN `if`.
 * Round 4 fixed the FACADE (app/actions/wms-onboarding.ts) so a second registered connector is
 * reported with its own label and its own `configured`, under a DTO keyed by connector. This file
 * — the one that renders it — still asked `connectorId === 'mintsoft'` and rendered `null`
 * otherwise, next to an enable switch that was on and a wizard step that ticks itself from
 * `configured`. A second connector therefore got a ticked, enabled, empty setup step: a screen
 * that claims everything is in order while showing nothing an operator can act on.
 *
 * So the dispatch is total over the id union ({@link WMS_CONNECTION_FORMS}): adding an id to
 * `WMS_CONNECTOR_IDS` without writing a form for it does not compile. A build that nevertheless
 * holds an unknown id — a plugin row from a connector this build no longer ships, a mixed-version
 * deploy — renders {@link WmsConnectionUnavailable}, which NAMES what is missing. No path through
 * this component renders nothing while the connector is enabled.
 *
 * The DTO's per-connector payload is `unknown` by design (lib/connectors/wms/connector-hooks.ts);
 * `render` is the one place allowed to narrow it.
 */

export type WmsConnectionFormProps = {
  /** The facade's opaque per-connector payload. Narrowed by the connector's own `render`. */
  payload: unknown
  connectorLabel: string
  busy: boolean
  availableOrderLookupConnectors: ShoppingLookupConnector[]
  withStepUp: <T extends MaybeFreshAuthFailure>(run: () => Promise<T>) => Promise<T>
  onBusyChange: (busy: boolean) => void
  onConnected: () => void
  onError: (message: string) => void
}

export type WmsConnectorConnectionForm = {
  render: (props: WmsConnectionFormProps) => React.ReactNode
}

/** Exported so tests/wms-second-connector-seam-ui.test.ts can assert its TOTALITY over the union. */
export const WMS_CONNECTION_FORMS: Record<WmsConnectorId, WmsConnectorConnectionForm> = {
  mintsoft: {
    render: ({ payload, ...rest }) => (
      <MintsoftConnectionForm data={payload as MintsoftOnboardingConnectionData} {...rest} />
    ),
  },
}

function lookupWmsConnectionForm(connectorId: string): WmsConnectorConnectionForm | null {
  return (WMS_CONNECTION_FORMS as Record<string, WmsConnectorConnectionForm | undefined>)[connectorId] ?? null
}

/**
 * WHAT AN OPERATOR SEES INSTEAD OF NOTHING, when the connector is enabled but this build cannot
 * render its setup form. `configured` is stated explicitly so a live connection is never mistaken
 * for one that still needs credentials — which is precisely the wrong turn the blank step invited.
 */
function WmsConnectionUnavailable({ reason, connectorLabel, connectorId, configured }: {
  reason: 'no-form' | 'no-data'
  connectorLabel: string
  connectorId: string
  configured: boolean
}) {
  return (
    <Card
      role="status"
      data-wms-connection-state={reason}
      className="border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100"
    >
      <p className="font-medium">
        {reason === 'no-form'
          ? `This build has no setup form for ${connectorLabel}.`
          : `${connectorLabel} returned no connection details to set up.`}
      </p>
      <p className="mt-1">
        {configured
          ? `The ${connectorLabel} connection is already set up — nothing is missing, and nothing needs re-entering here.`
          : `The ${connectorLabel} connection is not set up, and cannot be set up from this step.`}
        {' '}
        {reason === 'no-form'
          ? `Connector id ${connectorId} is enabled but this build ships no form for it.`
          : `Connector id ${connectorId} declares no setup form of its own.`}
      </p>
    </Card>
  )
}

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
  const form = lookupWmsConnectionForm(data.connectorId)
  const payload = (data.connectorData as Record<string, unknown>)[data.connectorId]
  // Every branch below renders SOMETHING. `null` under an enabled switch is the defect this
  // registry exists to remove, so the two ways a form can be missing are named, not elided.
  const connectionForm = form === null
    ? (
      <WmsConnectionUnavailable
        reason="no-form"
        connectorLabel={data.connectorLabel}
        connectorId={data.connectorId}
        configured={data.configured}
      />
    )
    : payload === undefined
      ? (
        <WmsConnectionUnavailable
          reason="no-data"
          connectorLabel={data.connectorLabel}
          connectorId={data.connectorId}
          configured={data.configured}
        />
      )
      : form.render({
        payload,
        connectorLabel: data.connectorLabel,
        busy,
        availableOrderLookupConnectors,
        withStepUp,
        onBusyChange,
        onConnected,
        onError,
      })

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
      {enabled ? connectionForm : null}
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
