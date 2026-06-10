'use client'

import { useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import {
  Boxes, BookOpen, Calculator, CalendarClock, Check, ExternalLink,
  Loader2, ShoppingCart, Store,
} from 'lucide-react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { saveShoppingConnectorCredentials, saveShopifyConnectorCredentials } from '@/app/actions/shopping-sync'
import { connectAccountingConnector, saveAccountingConnectionSettings } from '@/app/actions/accounting-sync'
import { saveMintsoftConnectionSettings } from '@/app/actions/mintsoft-sync'
import { saveOnboardingPluginState } from '@/app/actions/onboarding'
import type { IntegrationPluginState } from '@/lib/integration-plugins'
import type { ShoppingConnectorCredentials, ShopifyConnectorCredentials } from '@/app/actions/shopping-sync'
import type { AccountingConnectionStatus, AccountingConnectorId, AccountingConnectorSettingsMasked } from '@/app/actions/accounting-sync'
import type { MintsoftOnboardingConnectionData } from '@/app/actions/mintsoft-sync'
import type { PublicAppUrlInfo } from '@/lib/public-app-url'

type Props = {
  pluginState: IntegrationPluginState
  wcCredentials: ShoppingConnectorCredentials
  shopifyCredentials: ShopifyConnectorCredentials
  accountingSettings: AccountingConnectorSettingsMasked
  accountingStatus: AccountingConnectionStatus
  mintsoftConnection: MintsoftOnboardingConnectionData
  publicAppUrlInfo: PublicAppUrlInfo
  onPluginStateChange: (state: IntegrationPluginState) => void
  onConnectionStateChange: (state: {
    wc?: boolean
    shopify?: boolean
    accounting?: boolean
    mintsoft?: boolean
  }) => void
  onReadyChange: (ready: boolean) => void
}

export function IntegrationsStep({
  pluginState: initialPluginState,
  wcCredentials: initialWcCreds,
  shopifyCredentials: initialShopifyCreds,
  accountingSettings: initialAccountingSettings,
  accountingStatus: initialAccountingStatus,
  mintsoftConnection: initialMintsoftConnection,
  publicAppUrlInfo,
  onPluginStateChange,
  onConnectionStateChange,
  onReadyChange,
}: Props) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [plugins, setPlugins] = useState(initialPluginState)
  const [error, setError] = useState('')
  const [savingPlugins, setSavingPlugins] = useState(false)
  const [savingWc, setSavingWc] = useState(false)
  const [savingShopify, setSavingShopify] = useState(false)
  const [savingMintsoft, setSavingMintsoft] = useState(false)
  const [savingAccountingConnection, setSavingAccountingConnection] = useState(false)
  const [connectingAccounting, setConnectingAccounting] = useState(false)

  // WooCommerce credentials
  const [wcUrl, setWcUrl] = useState(initialWcCreds.url)
  const [wcKey, setWcKey] = useState(initialWcCreds.key)
  const [wcSecret, setWcSecret] = useState(initialWcCreds.secretMasked ? '' : initialWcCreds.secret)
  const [wcSaved, setWcSaved] = useState(false)
  const [wcMessage, setWcMessage] = useState('')

  // Shopify credentials
  const [shopifyDomain, setShopifyDomain] = useState(initialShopifyCreds.storeDomain)
  const [shopifyToken, setShopifyToken] = useState(initialShopifyCreds.accessTokenMasked ? '' : initialShopifyCreds.adminApiAccessToken)
  const [shopifyWebhookSecret, setShopifyWebhookSecret] = useState(initialShopifyCreds.webhookSecretMasked ? '' : initialShopifyCreds.webhookSecret)
  const [shopifySaved, setShopifySaved] = useState(false)
  const [shopifyMessage, setShopifyMessage] = useState('')

  // Mintsoft credentials
  const [mintsoftBaseUrl, setMintsoftBaseUrl] = useState(initialMintsoftConnection.connection.baseUrl)
  const [mintsoftUsername, setMintsoftUsername] = useState(initialMintsoftConnection.connection.username)
  const [mintsoftPassword, setMintsoftPassword] = useState(initialMintsoftConnection.connection.passwordMasked ? '' : initialMintsoftConnection.connection.password)
  const [mintsoftWebhookSecret, setMintsoftWebhookSecret] = useState(initialMintsoftConnection.connection.webhookSecretMasked ? '' : initialMintsoftConnection.connection.webhookSecret)
  const [mintsoftOrderLookupConnector, setMintsoftOrderLookupConnector] = useState(initialMintsoftConnection.connection.orderLookupConnector)
  const [mintsoftSaved, setMintsoftSaved] = useState(false)
  const [mintsoftMessage, setMintsoftMessage] = useState('')

  // Accounting credentials
  const [acClientId, setAcClientId] = useState(initialAccountingSettings.client_id ?? initialAccountingSettings.xero_client_id ?? initialAccountingSettings.quickbooks_client_id ?? '')
  const [acClientSecret, setAcClientSecret] = useState(
    initialAccountingSettings.secretMasked
      ? ''
      : (initialAccountingSettings.client_secret ?? initialAccountingSettings.xero_client_secret ?? initialAccountingSettings.quickbooks_client_secret ?? ''),
  )
  const [acSaved, setAcSaved] = useState(false)
  const [accountingMessage, setAccountingMessage] = useState('')
  const [accountingConnectedLocal, setAccountingConnectedLocal] = useState(initialAccountingStatus.connected)

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
    setMintsoftBaseUrl(initialMintsoftConnection.connection.baseUrl)
    setMintsoftUsername(initialMintsoftConnection.connection.username)
    setMintsoftPassword(initialMintsoftConnection.connection.passwordMasked ? '' : initialMintsoftConnection.connection.password)
    setMintsoftWebhookSecret(initialMintsoftConnection.connection.webhookSecretMasked ? '' : initialMintsoftConnection.connection.webhookSecret)
    setMintsoftOrderLookupConnector(initialMintsoftConnection.connection.orderLookupConnector)
  }, [initialMintsoftConnection])

  useEffect(() => {
    setAcClientId(initialAccountingSettings.client_id ?? initialAccountingSettings.xero_client_id ?? initialAccountingSettings.quickbooks_client_id ?? '')
    setAcClientSecret(
      initialAccountingSettings.secretMasked
        ? ''
        : (initialAccountingSettings.client_secret ?? initialAccountingSettings.xero_client_secret ?? initialAccountingSettings.quickbooks_client_secret ?? ''),
    )
  }, [initialAccountingSettings])

  useEffect(() => {
    setAccountingConnectedLocal(initialAccountingStatus.connected)
  }, [initialAccountingStatus.connected])

  const accountingSuccess = searchParams.get('accounting_success')
  const accountingCallbackError = searchParams.get('accounting_error')

  useEffect(() => {
    if (!accountingSuccess && !accountingCallbackError) return

    setConnectingAccounting(false)
    setSavingAccountingConnection(false)

    if (accountingSuccess) {
      setAcSaved(true)
      setAccountingConnectedLocal(true)
      setAccountingMessage(`Connected to ${accountingSuccess}`)
      setError('')
      onConnectionStateChange({ accounting: true })
      router.refresh()
    } else if (accountingCallbackError) {
      setAcSaved(false)
      setAccountingMessage('')
      setError(accountingCallbackError)
    }

    window.history.replaceState({}, '', '/onboarding')
  }, [accountingCallbackError, accountingSuccess, onConnectionStateChange, router])

  useEffect(() => {
    function resetTransientBusyState() {
      setConnectingAccounting(false)
      setSavingAccountingConnection(false)
      setSavingPlugins(false)
      setSavingWc(false)
      setSavingShopify(false)
      setSavingMintsoft(false)
    }

    window.addEventListener('pageshow', resetTransientBusyState)
    return () => window.removeEventListener('pageshow', resetTransientBusyState)
  }, [])

  function buildNextPlugins(current: IntegrationPluginState, key: keyof IntegrationPluginState, value: boolean): IntegrationPluginState {
    const next = { ...current, [key]: value }
    if (key === 'woocommerce' && value) next.shopify = false
    if (key === 'shopify' && value) next.woocommerce = false
    if (key === 'xero' && value) next.quickbooks = false
    if (key === 'quickbooks' && value) next.xero = false
    return next
  }

  async function persistPlugins(nextPlugins: IntegrationPluginState, previousPlugins?: IntegrationPluginState) {
    const result = await saveOnboardingPluginState(nextPlugins)
    if (!result.success) {
      setError(result.error ?? 'Failed to save plugin settings')
      if (previousPlugins) setPlugins(previousPlugins)
      return false
    }
    onPluginStateChange(nextPlugins)
    return true
  }

  function togglePlugin(key: keyof IntegrationPluginState, value: boolean) {
    if (savingPlugins || savingWc || savingShopify || savingMintsoft || savingAccountingConnection || connectingAccounting) return
    const previousPlugins = plugins
    const nextPlugins = buildNextPlugins(previousPlugins, key, value)
    setError('')
    setPlugins(nextPlugins)
    setSavingPlugins(true)
    void (async () => {
      try {
        await persistPlugins(nextPlugins, previousPlugins)
      } catch (e) {
        setPlugins(previousPlugins)
        setError(e instanceof Error ? e.message : 'Failed to save')
      } finally {
        setSavingPlugins(false)
      }
    })()
  }

  function handleSaveWcCredentials() {
    if (savingPlugins || savingWc || savingShopify || savingMintsoft || savingAccountingConnection || connectingAccounting) return
    setError('')
    setWcSaved(false)
    setWcMessage('')
    setSavingWc(true)
    void (async () => {
      try {
        const result = await saveShoppingConnectorCredentials(wcUrl, wcKey, wcSecret)
        if (!result.success) {
          setError(result.error ?? 'Failed to save WooCommerce credentials')
          return
        }
        setWcSaved(true)
        setWcMessage(result.message ?? 'Connection verified and saved.')
        onConnectionStateChange({ wc: true })
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
    if (savingPlugins || savingWc || savingShopify || savingMintsoft || savingAccountingConnection || connectingAccounting) return
    setError('')
    setShopifySaved(false)
    setShopifyMessage('')
    setSavingShopify(true)
    void (async () => {
      try {
        const result = await saveShopifyConnectorCredentials(shopifyDomain, shopifyToken, shopifyWebhookSecret)
        if (!result.success) {
          setError(result.error ?? 'Failed to save Shopify credentials')
          return
        }
        setShopifySaved(true)
        setShopifyMessage(result.message ?? 'Connection verified and saved.')
        onConnectionStateChange({ shopify: true })
        router.refresh()
        setTimeout(() => setShopifySaved(false), 2000)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to save Shopify credentials')
      } finally {
        setSavingShopify(false)
      }
    })()
  }

  function handleSaveMintsoftConnection() {
    if (savingPlugins || savingWc || savingShopify || savingMintsoft || savingAccountingConnection || connectingAccounting) return
    setError('')
    setMintsoftSaved(false)
    setMintsoftMessage('')
    setSavingMintsoft(true)
    void (async () => {
      try {
        const result = await saveMintsoftConnectionSettings({
          baseUrl: mintsoftBaseUrl,
          username: mintsoftUsername,
          password: mintsoftPassword,
          webhookSecret: mintsoftWebhookSecret,
          orderLookupConnector: mintsoftOrderLookupConnector,
          active: true,
        })
        if (!result.success) {
          setError(result.error ?? 'Failed to save Mintsoft connection')
          return
        }
        setMintsoftSaved(true)
        setMintsoftMessage(result.message ?? 'Connection verified and saved.')
        onConnectionStateChange({ mintsoft: true })
        router.refresh()
        setTimeout(() => setMintsoftSaved(false), 2000)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to save Mintsoft connection')
      } finally {
        setSavingMintsoft(false)
      }
    })()
  }

  function handleSaveAccountingConnection() {
    if (savingPlugins || savingWc || savingShopify || savingMintsoft || savingAccountingConnection || connectingAccounting) return
    const selectedAccountingConnector: AccountingConnectorId = plugins.quickbooks ? 'quickbooks' : 'xero'
    const selectedAccountingLabel = selectedAccountingConnector === 'quickbooks' ? 'QuickBooks' : 'Xero'
    setError('')
    setAcSaved(false)
    setAccountingMessage('')
    setSavingAccountingConnection(true)
    void (async () => {
      try {
        const result = await saveAccountingConnectionSettings(acClientId, acClientSecret, selectedAccountingConnector)
        if (!result.success) {
          setError(result.error ?? `Failed to save ${selectedAccountingLabel} connection settings`)
          return
        }
        setAcSaved(true)
        setAccountingMessage(result.message ?? `${selectedAccountingLabel} app credentials saved. Use Connect & Verify to complete OAuth before leaving this step.`)
        router.refresh()
        setTimeout(() => setAcSaved(false), 2000)
      } catch (e) {
        setError(e instanceof Error ? e.message : `Failed to save ${selectedAccountingLabel} connection settings`)
      } finally {
        setSavingAccountingConnection(false)
      }
    })()
  }

  function handleConnectAccounting() {
    if (savingPlugins || savingWc || savingShopify || savingMintsoft || savingAccountingConnection || connectingAccounting) return
    const selectedAccountingConnector: AccountingConnectorId = plugins.quickbooks ? 'quickbooks' : 'xero'
    const selectedAccountingLabel = selectedAccountingConnector === 'quickbooks' ? 'QuickBooks' : 'Xero'
    setError('')
    setConnectingAccounting(true)
    void (async () => {
      try {
        const saveResult = await saveAccountingConnectionSettings(acClientId, acClientSecret, selectedAccountingConnector)
        if (!saveResult.success) {
          setError(saveResult.error ?? `Failed to save ${selectedAccountingLabel} connection settings`)
          return
        }
        setAcSaved(true)
        setAccountingMessage(saveResult.message ?? `${selectedAccountingLabel} app credentials saved. Redirecting to complete OAuth verification.`)

        const origin = window.location.origin
        const result = await connectAccountingConnector(acClientId, acClientSecret, origin, '/onboarding', selectedAccountingConnector)
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
  const hasWmsConnector = plugins.mintsoft
  const accountingLabel = plugins.quickbooks ? 'QuickBooks' : 'Xero'
  const hasPublicAppUrl = Boolean(publicAppUrlInfo.value)
  const hasSavedAccountingSecret = initialAccountingSettings.secretMasked
  const hasAccountingSecret = Boolean(acClientSecret.trim()) || hasSavedAccountingSecret
  const busy = savingPlugins || savingWc || savingShopify || savingMintsoft || savingAccountingConnection || connectingAccounting
  const availableMintsoftOrderLookupConnectors = [
    plugins.woocommerce ? 'woocommerce' : null,
    plugins.shopify ? 'shopify' : null,
  ].filter((value): value is 'woocommerce' | 'shopify' => value !== null)
  const mintsoftOrderLookupRequired = availableMintsoftOrderLookupConnectors.length > 1
  const wcConnected = wcSaved || (!!initialWcCreds.url && !!initialWcCreds.key && initialWcCreds.secretMasked)
  const shopifyConnected = shopifySaved || (!!initialShopifyCreds.storeDomain && initialShopifyCreds.accessTokenMasked)
  const accountingConnected = accountingConnectedLocal || initialAccountingStatus.connected
  const mintsoftConnected = mintsoftSaved || initialMintsoftConnection.status.configured
  const wcConnectedLabel = wcUrl.trim() || initialWcCreds.url || 'WooCommerce store'
  const shopifyConnectedLabel = shopifyDomain.trim() || initialShopifyCreds.storeDomain || 'Shopify store'
  const accountingConnectedLabel = initialAccountingStatus.tenantName || accountingLabel
  const mintsoftConnectedLabel = mintsoftUsername.trim() || mintsoftBaseUrl.trim() || 'Mintsoft account'

  useEffect(() => {
    const ready =
      (plugins.woocommerce ? wcConnected : true)
      && (plugins.shopify ? shopifyConnected : true)
      && ((plugins.xero || plugins.quickbooks) ? accountingConnected : true)
      && (plugins.mintsoft ? mintsoftConnected : true)
      && (plugins.woocommerce || plugins.shopify || plugins.xero || plugins.quickbooks || plugins.mintsoft)
    onReadyChange(ready)
  }, [
    accountingConnected,
    mintsoftConnected,
    onReadyChange,
    plugins,
    shopifyConnected,
    wcConnected,
  ])

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Integrations</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Connect your online store and accounting system. You can skip this step and set up integrations later in Settings.
        </p>
      </div>

      <div className="space-y-3">
        <h3 className="text-sm font-medium">Enable Integrations</h3>

        <label className="flex items-start gap-3 cursor-pointer rounded-lg border p-3 hover:bg-muted/50 transition-colors">
          <Switch checked={plugins.woocommerce} onCheckedChange={(v) => togglePlugin('woocommerce', v)} className="mt-0.5" disabled={busy} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <ShoppingCart className="h-4 w-4 text-purple-600" />
              <span className="text-sm font-medium">WooCommerce</span>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">Sync orders and products from your WooCommerce store</p>
          </div>
        </label>
        {plugins.woocommerce && (
          <Card className="p-4 space-y-4">
            {wcConnected ? (
              <div className="flex items-center gap-2 rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-800">
                <Check className="h-4 w-4" />
                Connected to <strong>{wcConnectedLabel}</strong>
              </div>
            ) : null}
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
              <div className="rounded-md border bg-muted/20 p-3 sm:col-span-2">
                <div className="text-xs font-medium">Webhook Secret</div>
                <p className="text-xs text-muted-foreground">
                  The WooCommerce webhook secret verifies incoming order/product webhooks and signs customer invoice PDF requests
                  from the OneTwoInventory Helper plugin. Generate it in Integrations after the connection is verified, then paste
                  the same value into WordPress Admin - Settings - OneTwoInventory Helper. Rotating it requires updating both sides.
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Button type="button" onClick={handleSaveWcCredentials} disabled={busy} size="sm">
                {savingWc ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                {wcSaved ? <><Check className="h-4 w-4 mr-1" />Verified</> : 'Save & Test Connection'}
              </Button>
              {wcMessage ? <span className="text-xs text-muted-foreground">{wcMessage}</span> : null}
            </div>
          </Card>
        )}

        <label className="flex items-start gap-3 cursor-pointer rounded-lg border p-3 hover:bg-muted/50 transition-colors">
          <Switch checked={plugins.shopify} onCheckedChange={(v) => togglePlugin('shopify', v)} className="mt-0.5" disabled={busy} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <Store className="h-4 w-4 text-green-600" />
              <span className="text-sm font-medium">Shopify</span>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">Sync orders and products from your Shopify store</p>
          </div>
        </label>
        {plugins.shopify && (
          <Card className="p-4 space-y-4">
            {shopifyConnected ? (
              <div className="flex items-center gap-2 rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-800">
                <Check className="h-4 w-4" />
                Connected to <strong>{shopifyConnectedLabel}</strong>
              </div>
            ) : null}
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
            <div className="flex flex-wrap items-center gap-3">
              <Button type="button" onClick={handleSaveShopifyCredentials} disabled={busy} size="sm">
                {savingShopify ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                {shopifySaved ? <><Check className="h-4 w-4 mr-1" />Verified</> : 'Save & Test Connection'}
              </Button>
              {shopifyMessage ? <span className="text-xs text-muted-foreground">{shopifyMessage}</span> : null}
            </div>
          </Card>
        )}

        <label className="flex items-start gap-3 cursor-pointer rounded-lg border p-3 hover:bg-muted/50 transition-colors">
          <Switch checked={plugins.xero} onCheckedChange={(v) => togglePlugin('xero', v)} className="mt-0.5" disabled={busy} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <BookOpen className="h-4 w-4 text-blue-600" />
              <span className="text-sm font-medium">Xero</span>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">Post journal entries and sync invoices to Xero</p>
          </div>
        </label>
        {plugins.xero && (
          <Card className="p-4 space-y-4">
            {accountingConnected ? (
              <div className="flex items-center gap-2 rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-800">
                <Check className="h-4 w-4" />
                Connected to <strong>{accountingConnectedLabel}</strong>
              </div>
            ) : (
              <>
                {!hasPublicAppUrl && (
                  <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
                    Set a Public App URL in the Company Details step before connecting to Xero.
                  </div>
                )}
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
                <div className="flex flex-wrap items-center gap-3">
                  <Button type="button" onClick={handleSaveAccountingConnection} disabled={busy || !acClientId || !hasAccountingSecret || !hasPublicAppUrl} size="sm">
                    {savingAccountingConnection ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                    {acSaved ? <><Check className="h-4 w-4 mr-1" />Saved</> : 'Save OAuth Settings'}
                  </Button>
                  <Button type="button" onClick={handleConnectAccounting} disabled={busy || !acClientId || !hasAccountingSecret || !hasPublicAppUrl} size="sm" variant="outline">
                    {connectingAccounting ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                    Connect & Verify Xero
                  </Button>
                  {accountingMessage ? <span className="text-xs text-muted-foreground">{accountingMessage}</span> : null}
                </div>
                <p className="text-xs text-muted-foreground">
                  Saving stores the OAuth app credentials only. Connect & Verify completes OAuth and records the connection-test gate; onboarding cannot continue until Xero is connected.
                </p>
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

        <label className="flex items-start gap-3 cursor-pointer rounded-lg border p-3 hover:bg-muted/50 transition-colors">
          <Switch checked={plugins.quickbooks} onCheckedChange={(v) => togglePlugin('quickbooks', v)} className="mt-0.5" disabled={busy} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <Calculator className="h-4 w-4 text-green-700" />
              <span className="text-sm font-medium">QuickBooks Online</span>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">Post journal entries and sync invoices to QuickBooks</p>
          </div>
        </label>
        {plugins.quickbooks && (
          <Card className="p-4 space-y-4">
            {accountingConnected ? (
              <div className="flex items-center gap-2 rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-800">
                <Check className="h-4 w-4" />
                Connected to <strong>{accountingConnectedLabel}</strong>
              </div>
            ) : (
              <>
                {!hasPublicAppUrl && (
                  <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
                    Set a Public App URL in the Company Details step before connecting to QuickBooks.
                  </div>
                )}
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
                <div className="flex flex-wrap items-center gap-3">
                  <Button type="button" onClick={handleSaveAccountingConnection} disabled={busy || !acClientId || !hasAccountingSecret || !hasPublicAppUrl} size="sm">
                    {savingAccountingConnection ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                    {acSaved ? <><Check className="h-4 w-4 mr-1" />Saved</> : 'Save OAuth Settings'}
                  </Button>
                  <Button type="button" onClick={handleConnectAccounting} disabled={busy || !acClientId || !hasAccountingSecret || !hasPublicAppUrl} size="sm" variant="outline">
                    {connectingAccounting ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                    Connect & Verify QuickBooks
                  </Button>
                  {accountingMessage ? <span className="text-xs text-muted-foreground">{accountingMessage}</span> : null}
                </div>
                <p className="text-xs text-muted-foreground">
                  Saving stores the OAuth app credentials only. Connect & Verify completes OAuth and records the connection-test gate; onboarding cannot continue until QuickBooks is connected.
                </p>
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

        <label className="flex items-start gap-3 cursor-pointer rounded-lg border p-3 hover:bg-muted/50 transition-colors">
          <Switch checked={plugins.mintsoft} onCheckedChange={(v) => togglePlugin('mintsoft', v)} className="mt-0.5" disabled={busy} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <Boxes className="h-4 w-4 text-amber-600" />
              <span className="text-sm font-medium">Mintsoft</span>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">Enable the Mintsoft WMS connector and warehouse binding tools</p>
          </div>
        </label>
        {plugins.mintsoft && (
          <Card className="p-4 space-y-4">
            {mintsoftConnected ? (
              <div className="flex items-center gap-2 rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-800">
                <Check className="h-4 w-4" />
                Connected to <strong>{mintsoftConnectedLabel}</strong>
              </div>
            ) : null}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1.5 sm:col-span-2">
                <Label className="text-xs">Base URL</Label>
                <Input
                  value={mintsoftBaseUrl}
                  onChange={(e) => setMintsoftBaseUrl(e.target.value)}
                  placeholder="https://api.mintsoft.co.uk/"
                  className="h-9"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Username</Label>
                <Input
                  value={mintsoftUsername}
                  onChange={(e) => setMintsoftUsername(e.target.value)}
                  placeholder="Mintsoft username"
                  className="h-9"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Password</Label>
                <Input
                  type="password"
                  value={mintsoftPassword}
                  onChange={(e) => setMintsoftPassword(e.target.value)}
                  placeholder={initialMintsoftConnection.connection.passwordMasked ? '••••••••' : 'Mintsoft password'}
                  className="h-9"
                />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label className="text-xs">Webhook Secret</Label>
                <Input
                  type="password"
                  value={mintsoftWebhookSecret}
                  onChange={(e) => setMintsoftWebhookSecret(e.target.value)}
                  placeholder={initialMintsoftConnection.connection.webhookSecretMasked ? '••••••••' : 'Shared secret'}
                  className="h-9"
                />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label className="text-xs">Order Lookup Connector</Label>
                <select
                  value={mintsoftOrderLookupConnector}
                  onChange={(e) => setMintsoftOrderLookupConnector(e.target.value as '' | 'woocommerce' | 'shopify')}
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                >
                  <option value="">None</option>
                  {availableMintsoftOrderLookupConnectors.includes('woocommerce') ? <option value="woocommerce">WooCommerce</option> : null}
                  {availableMintsoftOrderLookupConnectors.includes('shopify') ? <option value="shopify">Shopify</option> : null}
                </select>
                <p className="text-xs text-muted-foreground">
                  {mintsoftOrderLookupRequired
                    ? 'Required because more than one shopping connector is enabled.'
                    : availableMintsoftOrderLookupConnectors.length === 0
                      ? 'Optional. You can set this later after enabling a shopping connector.'
                      : 'Used to resolve storefront order numbers on Mintsoft callbacks.'}
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Button
                type="button"
                onClick={handleSaveMintsoftConnection}
                disabled={busy || (mintsoftOrderLookupRequired && !mintsoftOrderLookupConnector)}
                size="sm"
              >
                {savingMintsoft ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                {mintsoftSaved ? <><Check className="h-4 w-4 mr-1" />Verified</> : 'Save & Test Connection'}
              </Button>
              {mintsoftMessage ? <span className="text-xs text-muted-foreground">{mintsoftMessage}</span> : null}
              {initialMintsoftConnection.status.configured ? (
                <span className="text-xs text-muted-foreground">Mintsoft connection is already configured.</span>
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
        )}

      </div>

      <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
        <div className="flex items-center gap-2 font-medium">
          <CalendarClock className="h-4 w-4" />
          Production readiness
        </div>
        <div className="mt-2 grid gap-2 text-xs">
          <p>
            Before production, set a 32+ character <code className="rounded bg-amber-100 px-1 py-0.5">CRON_SECRET</code> and apply scheduler settings from{' '}
            <Link href="/settings/system?tab=scheduler" className="font-medium underline underline-offset-2">
              System scheduler
            </Link>
            .
          </p>
          <p>
            Enable scheduled backups and configure a remote backup target in{' '}
            <Link href="/settings/backup" className="font-medium underline underline-offset-2">
              Backup & Restore
            </Link>
            , then confirm the latest backup and cron freshness in operational health after deployment.
          </p>
        </div>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {!hasShoppingConnector && !hasAccountingConnector && !hasWmsConnector && (
        <p className="text-sm text-muted-foreground italic">
          No integrations selected. You can enable them at any time from Settings.
        </p>
      )}
    </div>
  )
}
