'use client'

import { useEffect, useState, useTransition } from 'react'
import { Check, Loader2 } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import {
  getMintsoftCourierServiceMap,
  getMintsoftOrderDispatchSettings,
  getMintsoftSendIossNumber,
  saveMintsoftSendIossNumber,
  saveMintsoftCourierServiceMap,
  saveMintsoftOrderDispatchSettings,
} from '@/app/actions/mintsoft-sync'

/**
 * Phase 8 carrier mapping: edit the IMS shipping-service → Mintsoft
 * CourierServiceId map consumed by the outbound order-push payload. Self-contained
 * — loads the current map on mount and saves via its own action.
 */
export function MintsoftCourierMapSection() {
  const [value, setValue] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')
  const [saving, startSaving] = useTransition()

  useEffect(() => {
    getMintsoftCourierServiceMap()
      .then((map) => setValue(map))
      .catch(() => undefined)
      .finally(() => setLoaded(true))
  }, [])

  function handleSave() {
    setError('')
    setSaved(false)
    startSaving(async () => {
      const result = await saveMintsoftCourierServiceMap(value)
      if (result.success) {
        setSaved(true)
        setTimeout(() => setSaved(false), 2000)
      } else {
        setError(result.error ?? 'Failed to save courier mapping.')
      }
    })
  }

  return (
    <Card className="p-4 space-y-3">
      <div>
        <h3 className="text-sm font-medium">Courier service mapping</h3>
        <p className="text-xs text-muted-foreground">
          Map IMS shipping-service names to Mintsoft courier service ids for outbound order dispatch. A JSON object,
          e.g. <code className="rounded bg-muted px-1">{'{ "Royal Mail Tracked 24": 12, "DPD Next Day": 34 }'}</code>.
          Unmapped services pass the name through for Mintsoft to resolve.
        </p>
      </div>
      <textarea
        value={value}
        onChange={(event) => setValue(event.target.value)}
        disabled={!loaded || saving}
        rows={6}
        placeholder='{ "Royal Mail Tracked 24": 12 }'
        className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs"
      />
      <div className="flex items-center gap-3">
        <Button size="sm" onClick={handleSave} disabled={!loaded || saving}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : saved ? <Check className="h-4 w-4 mr-1" /> : null}
          {saved ? 'Saved' : 'Save mapping'}
        </Button>
        {error && <span className="text-xs text-destructive">{error}</span>}
      </div>
    </Card>
  )
}

/**
 * Phase 8 order-dispatch settings that previously had no UI: the Mintsoft admin
 * deep-link template (used by the sales-order WMS status chip) and the default
 * courier service id (fallback when a shipping service isn't in the map above).
 */
export function MintsoftOrderDispatchSection() {
  const [template, setTemplate] = useState('')
  const [courierId, setCourierId] = useState('')
  const [clientId, setClientId] = useState('')
  const [channelId, setChannelId] = useState('')
  const [warehouseId, setWarehouseId] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')
  const [saving, startSaving] = useTransition()

  useEffect(() => {
    getMintsoftOrderDispatchSettings()
      .then((s) => {
        setTemplate(s.adminOrderUrlTemplate)
        setCourierId(s.defaultCourierServiceId)
        setClientId(s.clientId)
        setChannelId(s.channelId)
        setWarehouseId(s.warehouseId)
      })
      .catch(() => undefined)
      .finally(() => setLoaded(true))
  }, [])

  function handleSave() {
    setError('')
    setSaved(false)
    startSaving(async () => {
      const result = await saveMintsoftOrderDispatchSettings({
        adminOrderUrlTemplate: template,
        defaultCourierServiceId: courierId,
        clientId,
        channelId,
        warehouseId,
      })
      if (result.success) {
        setSaved(true)
        setTimeout(() => setSaved(false), 2000)
      } else {
        setError(result.error ?? 'Failed to save dispatch settings.')
      }
    })
  }

  return (
    <Card className="p-4 space-y-3">
      <div>
        <h3 className="text-sm font-medium">Order dispatch settings</h3>
        <p className="text-xs text-muted-foreground">Used by the outbound order push and the sales-order WMS status chip.</p>
      </div>

      <div className="space-y-1">
        <label className="text-xs font-medium" htmlFor="mintsoft-admin-url">Admin order URL template</label>
        <input
          id="mintsoft-admin-url"
          value={template}
          onChange={(event) => setTemplate(event.target.value)}
          disabled={!loaded || saving}
          placeholder="https://app.fulfillable.co.uk/Order/Details/{id}"
          className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs"
        />
        <p className="text-xs text-muted-foreground">
          Deep-link target for the order-status chip. <code className="rounded bg-muted px-1">{'{id}'}</code> is replaced with the
          Mintsoft order id. Leave blank to use the default.
        </p>
      </div>

      <div className="space-y-1">
        <label className="text-xs font-medium" htmlFor="mintsoft-default-courier">Default courier service id</label>
        <input
          id="mintsoft-default-courier"
          value={courierId}
          onChange={(event) => setCourierId(event.target.value)}
          disabled={!loaded || saving}
          inputMode="numeric"
          placeholder="e.g. 12"
          className="w-40 rounded-md border border-input bg-background px-3 py-2 font-mono text-xs"
        />
        <p className="text-xs text-muted-foreground">
          Courier service id used when a shipping service isn&apos;t in the map above. Leave blank for no fallback.
        </p>
      </div>

      <div className="space-y-1">
        <label className="text-xs font-medium" htmlFor="mintsoft-client-id">Client ID (inbound delta scope)</label>
        <input
          id="mintsoft-client-id"
          value={clientId}
          onChange={(event) => setClientId(event.target.value)}
          disabled={!loaded || saving}
          inputMode="numeric"
          placeholder="e.g. 1234"
          className="w-40 rounded-md border border-input bg-background px-3 py-2 font-mono text-xs"
        />
        <p className="text-xs text-muted-foreground">
          Our Mintsoft ClientId. <strong>Required</strong> for all Mintsoft dispatch reconciliation — Mintsoft is a shared 3PL
          tenant, so every order lookup must be scoped to our client to avoid acting on another client&apos;s order. Leave blank
          and Mintsoft dispatch sync is <strong>disabled</strong> (skipped each run, no orders touched) until it is set.
        </p>
      </div>

      <div className="flex gap-3">
        <div className="space-y-1">
          <label className="text-xs font-medium" htmlFor="mintsoft-channel-id">Channel ID (optional)</label>
          <input
            id="mintsoft-channel-id"
            value={channelId}
            onChange={(event) => setChannelId(event.target.value)}
            disabled={!loaded || saving}
            inputMode="numeric"
            placeholder="optional"
            className="w-40 rounded-md border border-input bg-background px-3 py-2 font-mono text-xs"
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium" htmlFor="mintsoft-warehouse-id">Warehouse ID (optional)</label>
          <input
            id="mintsoft-warehouse-id"
            value={warehouseId}
            onChange={(event) => setWarehouseId(event.target.value)}
            disabled={!loaded || saving}
            inputMode="numeric"
            placeholder="optional"
            className="w-40 rounded-md border border-input bg-background px-3 py-2 font-mono text-xs"
          />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Optional extra filters that further scope the inbound Order/List delta.
      </p>

      <div className="flex items-center gap-3">
        <Button size="sm" onClick={handleSave} disabled={!loaded || saving}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : saved ? <Check className="h-4 w-4 mr-1" /> : null}
          {saved ? 'Saved' : 'Save dispatch settings'}
        </Button>
        {error && <span className="text-xs text-destructive">{error}</span>}
      </div>
    </Card>
  )
}

/**
 * Whether the order create push sends `IOSSNumber`. Off by default; Mintsoft is live, so it is an explicit opt-in. Saves on change.
 */
export function MintsoftSendIossNumberSection() {
  const [enabled, setEnabled] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState('')
  const [saving, startSaving] = useTransition()

  useEffect(() => {
    getMintsoftSendIossNumber()
      .then(setEnabled)
      .catch(() => undefined)
      .finally(() => setLoaded(true))
  }, [])

  function handleChange(next: boolean) {
    setError('')
    startSaving(async () => {
      const result = await saveMintsoftSendIossNumber(next)
      if (result.success) setEnabled(next)
      else setError(result.error ?? 'Failed to save the IOSS number setting.')
    })
  }

  return (
    <Card className="p-4 space-y-2">
      <h3 className="text-sm font-medium">IOSS number on order push</h3>
      <label className="flex items-center gap-2 text-sm" htmlFor="mintsoft-send-ioss-number">
        <input
          id="mintsoft-send-ioss-number"
          type="checkbox"
          checked={enabled}
          disabled={!loaded || saving}
          onChange={(event) => handleChange(event.target.checked)}
        />
        Send the IOSS number to Mintsoft (<code className="rounded bg-muted px-1">IOSSNumber</code>)
      </label>
      <p className="text-xs text-muted-foreground">
        Off by default. When on, a new order is created in Mintsoft with the IOSS number WooCommerce applied to it, only for orders that carry one.
        The number is copied from WooCommerce, never worked out here. Orders already in Mintsoft are not changed.
      </p>
      {error && <span className="text-xs text-destructive">{error}</span>}
    </Card>
  )
}
