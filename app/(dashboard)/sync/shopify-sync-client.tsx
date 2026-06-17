'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { AlertTriangle, Check, Copy, Loader2, RefreshCw } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { LoadingProgress } from '@/components/ui/loading-progress'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useFormatDateTime } from '@/components/providers/timezone-provider'
import {
  saveShopifyConnectorCredentials,
  saveShopifySyncSettings,
  triggerShopifyManualSync,
  type ShopifyConnectorCredentials,
  type ShopifySyncSettings,
  type ShoppingSyncLogRow,
} from '@/app/actions/shopping-sync'

type Props = {
  settings: ShopifySyncSettings
  credentials: ShopifyConnectorCredentials
  logs: ShoppingSyncLogRow[]
}

function generateSecret(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  const bytes = new Uint8Array(48)
  crypto.getRandomValues(bytes)

  let result = ''
  for (const byte of bytes) result += chars[byte % chars.length]
  return result
}

function formatManualSyncResult(result: unknown): string {
  if (!result || typeof result !== 'object') return 'Stock sync completed'
  const payload = result as Record<string, unknown>
  const synced = Number(payload.synced ?? 0)
  const errors = Array.isArray(payload.errors) ? (payload.errors as string[]) : []

  if (errors.length > 0) {
    return `Stock sync finished with ${errors.length} error(s) — ${errors.join('; ')}`
  }

  return `Stock sync completed — ${synced} product(s) updated`
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

export function ShopifySyncClient({ settings: initialSettings, credentials, logs }: Props) {
  const formatDateTime = useFormatDateTime()
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [syncPending, startSyncTransition] = useTransition()
  const [storeDomain, setStoreDomain] = useState(credentials.storeDomain)
  const [accessToken, setAccessToken] = useState(credentials.adminApiAccessToken)
  const [webhookSecret, setWebhookSecret] = useState(credentials.webhookSecret)
  const [syncEnabled, setSyncEnabled] = useState(initialSettings.shopify_sync_enabled === 'true')
  const [saveMessage, setSaveMessage] = useState<string | null>(null)
  const [saveError, setSaveError] = useState(false)
  const [settingsMessage, setSettingsMessage] = useState<string | null>(null)
  const [settingsError, setSettingsError] = useState(false)
  const [syncMessage, setSyncMessage] = useState<string | null>(null)
  const [syncError, setSyncError] = useState(false)
  const [copied, setCopied] = useState(false)
  const configured = !!storeDomain && !!accessToken
  const webhookPreview = webhookSecret && !webhookSecret.includes('*') ? webhookSecret : ''

  function handleSaveConnection() {
    setSaveMessage(null)
    setSaveError(false)

    startTransition(async () => {
      const credentialResult = await saveShopifyConnectorCredentials(
        storeDomain.trim(),
        accessToken.trim(),
        webhookSecret.trim(),
      )
      if (!credentialResult.success) {
        setSaveError(true)
        setSaveMessage(credentialResult.error ?? 'Failed to save Shopify credentials')
        return
      }

      setSaveMessage(credentialResult.message ?? 'Connection verified and saved.')
      router.refresh()
    })
  }

  function handleSaveSettings() {
    setSettingsMessage(null)
    setSettingsError(false)

    startTransition(async () => {
      const settingsResult = await saveShopifySyncSettings({
        shopify_sync_enabled: String(syncEnabled),
      })
      if (!settingsResult.success) {
        setSettingsError(true)
        setSettingsMessage(settingsResult.error ?? 'Failed to save Shopify settings')
        return
      }

      setSettingsMessage('Shopify settings saved')
      router.refresh()
    })
  }

  function handleManualStockSync() {
    setSyncMessage(null)
    setSyncError(false)

    startSyncTransition(async () => {
      const result = await triggerShopifyManualSync('stock')
      if (!result.success) {
        setSyncError(true)
        setSyncMessage(result.error ?? 'Failed to run Shopify stock sync')
        return
      }

      setSyncMessage(formatManualSyncResult(result.result))
      router.refresh()
    })
  }

  function handleGenerateSecret() {
    setWebhookSecret(generateSecret())
  }

  async function handleCopySecret() {
    if (!webhookPreview) return
    await navigator.clipboard.writeText(webhookPreview)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="space-y-4">
      <Card className="p-6 space-y-4">
        <div>
          <h2 className="text-base font-semibold">Connection</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Enter the Shopify store domain and Admin API access token for the custom app that this IMS should use.
          </p>
        </div>
        <EnvOverrideNotice overrides={credentials.envOverrides} />

        <div className="grid grid-cols-1 gap-3 max-w-lg">
          <div className="space-y-1.5">
            <Label>Store Domain</Label>
            <Input
              value={storeDomain}
              onChange={(event) => setStoreDomain(event.target.value)}
              placeholder="your-store.myshopify.com"
              className="h-9 text-sm font-mono"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Admin API Access Token</Label>
            <Input
              value={accessToken}
              onChange={(event) => setAccessToken(event.target.value)}
              placeholder="shpat_..."
              className="h-9 text-sm font-mono"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Webhook Secret</Label>
            <div className="flex gap-2">
              <Input
                value={webhookSecret}
                onChange={(event) => setWebhookSecret(event.target.value)}
                placeholder="Generate a shared secret for webhook verification"
                className="h-9 text-sm font-mono"
                type="password"
              />
              <Button variant="outline" type="button" onClick={handleGenerateSecret}>
                Generate
              </Button>
              {webhookPreview && (
                <Button variant="outline" type="button" onClick={handleCopySecret}>
                  {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                </Button>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              Use the same secret to verify incoming Shopify webhooks.
            </p>
          </div>
        </div>

        {configured && (
          <p className="text-xs text-green-600 flex items-center gap-1">
            <Check className="h-3 w-3" />
            Configured for {storeDomain}
          </p>
        )}

        <div className="flex items-center gap-2">
          <Button onClick={handleSaveConnection} disabled={isPending}>
            {isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Save Connection
          </Button>
          {saveMessage && (
            <span className={`text-sm ${saveError ? 'text-destructive' : 'text-green-600'}`}>
              {saveMessage}
            </span>
          )}
        </div>
      </Card>

      <Card className="p-6 space-y-4">
        <div>
          <h2 className="text-base font-semibold">Sync Settings</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Control whether IMS pushes stock updates to Shopify.
          </p>
        </div>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="h-4 w-4 rounded border-border"
            checked={syncEnabled}
            onChange={(event) => setSyncEnabled(event.target.checked)}
          />
          Enable Shopify stock sync
        </label>

        <div className="flex items-center gap-2">
          <Button onClick={handleSaveSettings} disabled={isPending}>
            {isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Save Settings
          </Button>
          {settingsMessage && (
            <span className={`text-sm ${settingsError ? 'text-destructive' : 'text-green-600'}`}>
              {settingsMessage}
            </span>
          )}
        </div>
      </Card>

      <Card className="p-6 space-y-4">
        <div>
          <h2 className="text-base font-semibold">Manual Sync</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Manual stock sync is wired. Order import, product metadata push, and fulfillment write-back still need dedicated Shopify workflows.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={handleManualStockSync} disabled={syncPending || !configured || !syncEnabled}>
            {syncPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
            Push Stock Now
          </Button>
          {syncMessage && (
            <span className={`text-sm ${syncError ? 'text-destructive' : 'text-green-600'}`}>
              {syncMessage}
            </span>
          )}
        </div>
        <LoadingProgress active={syncPending} label="Syncing Shopify..." className="max-w-sm" />
      </Card>

      <Card className="p-6 space-y-4">
        <div>
          <h2 className="text-base font-semibold">Webhook Routes</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Route paths are reserved now, but order, refund, and product webhook processing is not enabled yet.
            Leave Shopify subscriptions disabled until the business handlers are implemented.
          </p>
        </div>
        <div className="space-y-1 text-xs text-muted-foreground font-mono">
          <div>/api/webhooks/shopping/shopify/orders</div>
          <div>/api/webhooks/shopping/shopify/products</div>
          <div>/api/webhooks/shopping/shopify/refunds</div>
        </div>
      </Card>

      <Card className="p-6 space-y-4">
        <div>
          <h2 className="text-base font-semibold">Sync Log</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Recent Shopify connector sync attempts recorded in the shared shopping log.
          </p>
        </div>
        <Table className="rounded-md border">
          <TableHeader className="bg-muted/50">
            <TableRow>
              <TableHead className="text-xs">When</TableHead>
              <TableHead className="text-xs">Direction</TableHead>
              <TableHead className="text-xs">Status</TableHead>
              <TableHead className="text-xs">Entity</TableHead>
              <TableHead className="text-xs">Message</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {logs.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-sm text-muted-foreground">
                  No Shopify sync log entries yet.
                </TableCell>
              </TableRow>
            ) : logs.map((log) => (
              <TableRow key={log.id}>
                <TableCell className="text-xs text-muted-foreground">{formatDateTime(log.createdAt)}</TableCell>
                <TableCell className="text-xs">{log.direction}</TableCell>
                <TableCell className="text-xs">{log.status}</TableCell>
                <TableCell className="text-xs">{log.entityType}</TableCell>
                <TableCell className="text-xs text-muted-foreground">{log.errorMessage ?? 'OK'}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </div>
  )
}
