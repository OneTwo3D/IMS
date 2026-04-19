'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Check, ExternalLink, Loader2, ShoppingCart, Store, BookOpen, Calculator } from 'lucide-react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { saveShoppingConnectorCredentials, saveShopifyConnectorCredentials } from '@/app/actions/shopping-sync'
import { connectAccountingConnector, saveAccountingSettings } from '@/app/actions/accounting-sync'
import { saveOnboardingPluginState } from '@/app/actions/onboarding'
import type { IntegrationPluginState } from '@/lib/integration-plugins'
import type { ShoppingConnectorCredentials, ShopifyConnectorCredentials } from '@/app/actions/shopping-sync'
import type { AccountingConnectionStatus, AccountingConnectorSettingsMasked } from '@/app/actions/accounting-sync'

type Props = {
  pluginState: IntegrationPluginState
  wcCredentials: ShoppingConnectorCredentials
  shopifyCredentials: ShopifyConnectorCredentials
  accountingSettings: AccountingConnectorSettingsMasked
  accountingStatus: AccountingConnectionStatus
  onPluginStateChange: (state: IntegrationPluginState) => void
}

export function IntegrationsStep({
  pluginState: initialPluginState,
  wcCredentials: initialWcCreds,
  shopifyCredentials: initialShopifyCreds,
  accountingSettings: initialAccountingSettings,
  accountingStatus: initialAccountingStatus,
  onPluginStateChange,
}: Props) {
  const router = useRouter()
  const [plugins, setPlugins] = useState(initialPluginState)
  const [pluginsSaved, setPluginsSaved] = useState(false)
  const [error, setError] = useState('')
  const [savingPlugins, setSavingPlugins] = useState(false)
  const [savingWc, setSavingWc] = useState(false)
  const [savingShopify, setSavingShopify] = useState(false)
  const [connectingAccounting, setConnectingAccounting] = useState(false)

  // WooCommerce credentials
  const [wcUrl, setWcUrl] = useState(initialWcCreds.url)
  const [wcKey, setWcKey] = useState(initialWcCreds.key)
  const [wcSecret, setWcSecret] = useState(initialWcCreds.secretMasked ? '' : initialWcCreds.secret)
  const [wcSaved, setWcSaved] = useState(false)

  // Shopify credentials
  const [shopifyDomain, setShopifyDomain] = useState(initialShopifyCreds.storeDomain)
  const [shopifyToken, setShopifyToken] = useState(initialShopifyCreds.accessTokenMasked ? '' : initialShopifyCreds.adminApiAccessToken)
  const [shopifyWebhookSecret, setShopifyWebhookSecret] = useState(initialShopifyCreds.webhookSecretMasked ? '' : initialShopifyCreds.webhookSecret)
  const [shopifySaved, setShopifySaved] = useState(false)

  // Accounting credentials
  const [acClientId, setAcClientId] = useState(initialAccountingSettings.client_id ?? initialAccountingSettings.xero_client_id ?? initialAccountingSettings.quickbooks_client_id ?? '')
  const [acClientSecret, setAcClientSecret] = useState(initialAccountingSettings.secretMasked ? '' : (initialAccountingSettings.client_secret ?? ''))
  const accountingStatus = initialAccountingStatus
  const [acSaved, setAcSaved] = useState(false)

  useEffect(() => {
    setPlugins(initialPluginState)
  }, [initialPluginState])

  useEffect(() => {
    setWcUrl(initialWcCreds.url)
    setWcKey(initialWcCreds.key)
    setWcSecret(initialWcCreds.secretMasked ? '' : initialWcCreds.secret)
  }, [initialWcCreds])

  useEffect(() => {
    setShopifyDomain(initialShopifyCreds.storeDomain)
    setShopifyToken(initialShopifyCreds.accessTokenMasked ? '' : initialShopifyCreds.adminApiAccessToken)
    setShopifyWebhookSecret(initialShopifyCreds.webhookSecretMasked ? '' : initialShopifyCreds.webhookSecret)
  }, [initialShopifyCreds])

  useEffect(() => {
    setAcClientId(initialAccountingSettings.client_id ?? initialAccountingSettings.xero_client_id ?? initialAccountingSettings.quickbooks_client_id ?? '')
    setAcClientSecret(initialAccountingSettings.secretMasked ? '' : (initialAccountingSettings.client_secret ?? ''))
  }, [initialAccountingSettings])

  async function persistPlugins(nextPlugins = plugins) {
    const result = await saveOnboardingPluginState(nextPlugins)
    if (!result.success) {
      setError(result.error ?? 'Failed to save plugin settings')
      return false
    }
    onPluginStateChange(nextPlugins)
    return true
  }

  function togglePlugin(key: keyof IntegrationPluginState, value: boolean) {
    setPlugins((prev) => {
      const next = { ...prev, [key]: value }
      // Shopping connectors are exclusive
      if (key === 'woocommerce' && value) next.shopify = false
      if (key === 'shopify' && value) next.woocommerce = false
      // Accounting connectors are exclusive
      if (key === 'xero' && value) next.quickbooks = false
      if (key === 'quickbooks' && value) next.xero = false
      return next
    })
    setPluginsSaved(false)
  }

  function handleSavePlugins() {
    if (savingPlugins || savingWc || savingShopify || connectingAccounting) return
    setError('')
    setPluginsSaved(false)
    setSavingPlugins(true)
    void (async () => {
      try {
        const ok = await persistPlugins(plugins)
        if (!ok) return
        setPluginsSaved(true)
        router.refresh()
        setTimeout(() => setPluginsSaved(false), 2000)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to save')
      } finally {
        setSavingPlugins(false)
      }
    })()
  }

  function handleSaveWcCredentials() {
    if (savingPlugins || savingWc || savingShopify || connectingAccounting) return
    setError('')
    setWcSaved(false)
    setSavingWc(true)
    void (async () => {
      try {
        const result = await saveShoppingConnectorCredentials(wcUrl, wcKey, wcSecret)
        if (!result.success) {
          setError(result.error ?? 'Failed to save WooCommerce credentials')
          return
        }
        setWcSaved(true)
        router.refresh()
        setTimeout(() => setWcSaved(false), 2000)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to save WooCommerce credentials')
      } finally {
        setSavingWc(false)
      }
    })()
  }

  function handleSaveShopifyCredentials() {
    if (savingPlugins || savingWc || savingShopify || connectingAccounting) return
    setError('')
    setShopifySaved(false)
    setSavingShopify(true)
    void (async () => {
      try {
        const result = await saveShopifyConnectorCredentials(shopifyDomain, shopifyToken, shopifyWebhookSecret)
        if (!result.success) {
          setError(result.error ?? 'Failed to save Shopify credentials')
          return
        }
        setShopifySaved(true)
        router.refresh()
        setTimeout(() => setShopifySaved(false), 2000)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to save Shopify credentials')
      } finally {
        setSavingShopify(false)
      }
    })()
  }

  function handleConnectAccounting() {
    if (savingPlugins || savingWc || savingShopify || connectingAccounting) return
    setError('')
    setConnectingAccounting(true)
    void (async () => {
      try {
        const pluginsPersisted = await persistPlugins(plugins)
        if (!pluginsPersisted) return

        const connector = plugins.quickbooks ? 'quickbooks' : 'xero'
        const settingsData: Record<string, string> = {}
        if (connector === 'xero') {
          settingsData.xero_client_id = acClientId
          settingsData.xero_client_secret = acClientSecret
        } else {
          settingsData.quickbooks_client_id = acClientId
          settingsData.quickbooks_client_secret = acClientSecret
        }
        const saveResult = await saveAccountingSettings(settingsData)
        if (!saveResult.success) {
          setError(saveResult.error ?? 'Failed to save credentials')
          return
        }
        setAcSaved(true)

        const origin = window.location.origin
        const result = await connectAccountingConnector(acClientId, acClientSecret, origin, '/onboarding')
        if (result.redirectUrl) {
          window.location.href = result.redirectUrl
        } else if (result.error) {
          setError(result.error)
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to connect')
      } finally {
        setConnectingAccounting(false)
      }
    })()
  }

  const hasShoppingConnector = plugins.woocommerce || plugins.shopify
  const hasAccountingConnector = plugins.xero || plugins.quickbooks
  const accountingLabel = plugins.quickbooks ? 'QuickBooks' : 'Xero'

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Integrations</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Connect your online store and accounting system. You can skip this step and set up integrations later in Settings.
        </p>
      </div>

      {/* Plugin Toggles */}
      <div className="space-y-4">
        <h3 className="text-sm font-medium">Enable Integrations</h3>

        <div className="grid gap-3">
          <label className="flex items-start gap-3 cursor-pointer rounded-lg border p-3 hover:bg-muted/50 transition-colors">
            <Switch checked={plugins.woocommerce} onCheckedChange={(v) => togglePlugin('woocommerce', v)} className="mt-0.5" />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <ShoppingCart className="h-4 w-4 text-purple-600" />
                <span className="text-sm font-medium">WooCommerce</span>
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">Sync orders and products from your WooCommerce store</p>
            </div>
          </label>

          <label className="flex items-start gap-3 cursor-pointer rounded-lg border p-3 hover:bg-muted/50 transition-colors">
            <Switch checked={plugins.shopify} onCheckedChange={(v) => togglePlugin('shopify', v)} className="mt-0.5" />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <Store className="h-4 w-4 text-green-600" />
                <span className="text-sm font-medium">Shopify</span>
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">Sync orders and products from your Shopify store</p>
            </div>
          </label>

          <label className="flex items-start gap-3 cursor-pointer rounded-lg border p-3 hover:bg-muted/50 transition-colors">
            <Switch checked={plugins.xero} onCheckedChange={(v) => togglePlugin('xero', v)} className="mt-0.5" />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <BookOpen className="h-4 w-4 text-blue-600" />
                <span className="text-sm font-medium">Xero</span>
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">Post journal entries and sync invoices to Xero</p>
            </div>
          </label>

          <label className="flex items-start gap-3 cursor-pointer rounded-lg border p-3 hover:bg-muted/50 transition-colors">
            <Switch checked={plugins.quickbooks} onCheckedChange={(v) => togglePlugin('quickbooks', v)} className="mt-0.5" />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <Calculator className="h-4 w-4 text-green-700" />
                <span className="text-sm font-medium">QuickBooks Online</span>
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">Post journal entries and sync invoices to QuickBooks</p>
            </div>
          </label>
        </div>

        <Button type="button" onClick={handleSavePlugins} disabled={savingPlugins || savingWc || savingShopify || connectingAccounting} size="sm">
          {savingPlugins ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
          {pluginsSaved ? <><Check className="h-4 w-4 mr-1" />Saved</> : 'Save Plugin Settings'}
        </Button>
      </div>

      {/* WooCommerce Credentials */}
      {hasShoppingConnector && plugins.woocommerce && (
        <Card className="p-4 space-y-4">
          <h3 className="text-sm font-medium flex items-center gap-2">
            <ShoppingCart className="h-4 w-4 text-purple-600" />
            WooCommerce Credentials
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5 sm:col-span-2">
              <Label className="text-xs">Store URL</Label>
              <Input value={wcUrl} onChange={(e) => setWcUrl(e.target.value)} placeholder="https://yourstore.com" className="h-9" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Consumer Key</Label>
              <Input value={wcKey} onChange={(e) => setWcKey(e.target.value)} placeholder="ck_..." className="h-9" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Consumer Secret</Label>
              <Input
                type="password"
                value={wcSecret}
                onChange={(e) => setWcSecret(e.target.value)}
                placeholder={initialWcCreds.secretMasked ? '••••••••' : 'cs_...'}
                className="h-9"
              />
            </div>
          </div>
          <Button type="button" onClick={handleSaveWcCredentials} disabled={savingPlugins || savingWc || savingShopify || connectingAccounting} size="sm">
            {savingWc ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
            {wcSaved ? <><Check className="h-4 w-4 mr-1" />Saved</> : 'Save Credentials'}
          </Button>
        </Card>
      )}

      {/* Shopify Credentials */}
      {hasShoppingConnector && plugins.shopify && (
        <Card className="p-4 space-y-4">
          <h3 className="text-sm font-medium flex items-center gap-2">
            <Store className="h-4 w-4 text-green-600" />
            Shopify Credentials
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Store Domain</Label>
              <Input value={shopifyDomain} onChange={(e) => setShopifyDomain(e.target.value)} placeholder="mystore.myshopify.com" className="h-9" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Admin API Access Token</Label>
              <Input
                type="password"
                value={shopifyToken}
                onChange={(e) => setShopifyToken(e.target.value)}
                placeholder={initialShopifyCreds.accessTokenMasked ? '••••••••' : 'shpat_...'}
                className="h-9"
              />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label className="text-xs">Webhook Secret</Label>
              <Input
                type="password"
                value={shopifyWebhookSecret}
                onChange={(e) => setShopifyWebhookSecret(e.target.value)}
                placeholder={initialShopifyCreds.webhookSecretMasked ? '••••••••' : 'whsec_...'}
                className="h-9"
              />
            </div>
          </div>
          <Button type="button" onClick={handleSaveShopifyCredentials} disabled={savingPlugins || savingWc || savingShopify || connectingAccounting} size="sm">
            {savingShopify ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
            {shopifySaved ? <><Check className="h-4 w-4 mr-1" />Saved</> : 'Save Credentials'}
          </Button>
        </Card>
      )}

      {/* Accounting Connector */}
      {hasAccountingConnector && (
        <Card className="p-4 space-y-4">
          <h3 className="text-sm font-medium flex items-center gap-2">
            {plugins.quickbooks
              ? <Calculator className="h-4 w-4 text-green-700" />
              : <BookOpen className="h-4 w-4 text-blue-600" />}
            {accountingLabel} Connection
          </h3>

          {accountingStatus.connected ? (
            <div className="flex items-center gap-2 rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-800">
              <Check className="h-4 w-4" />
              Connected to <strong>{accountingStatus.tenantName}</strong>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs">Client ID</Label>
                  <Input value={acClientId} onChange={(e) => setAcClientId(e.target.value)} className="h-9" />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Client Secret</Label>
                  <Input
                    type="password"
                    value={acClientSecret}
                    onChange={(e) => setAcClientSecret(e.target.value)}
                    placeholder={initialAccountingSettings.secretMasked ? '••••••••' : ''}
                    className="h-9"
                  />
                </div>
              </div>
              <Button type="button" onClick={handleConnectAccounting} disabled={savingPlugins || savingWc || savingShopify || connectingAccounting || !acClientId}>
                {connectingAccounting ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                {acSaved ? 'Redirecting...' : `Connect to ${accountingLabel}`}
              </Button>
            </>
          )}

          <p className="text-xs text-muted-foreground">
            After connecting, you can complete account mapping and tax configuration in{' '}
            <Link href="/sync" className="text-primary hover:underline inline-flex items-center gap-0.5">
              Integrations <ExternalLink className="h-3 w-3" />
            </Link>
          </p>
        </Card>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}

      {!hasShoppingConnector && !hasAccountingConnector && (
        <p className="text-sm text-muted-foreground italic">
          No integrations selected. You can enable them at any time from Settings.
        </p>
      )}
    </div>
  )
}
