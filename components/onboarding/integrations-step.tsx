'use client'

import { ACCOUNTING_CONNECTORS } from '@/lib/connectors/accounting-registry'
import { useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import {
  BookOpen, CalendarClock, Check, ExternalLink,
  Loader2, ShoppingCart,
} from 'lucide-react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { useStepUpReauth, isFreshAuthFailure, type MaybeFreshAuthFailure } from '@/components/auth/use-step-up-reauth'
import { saveShoppingConnectorCredentials } from '@/app/actions/shopping-sync'
import { connectAccountingConnector, saveAccountingConnectionSettings } from '@/app/actions/accounting-sync'
import { saveOnboardingPluginState } from '@/app/actions/onboarding'
import {
  resolvePluginSelectionSaveView,
  type PluginSelectionSaveView,
} from '@/lib/domain/integrations/plugin-save-outcome'
import { WmsOnboardingConnection } from '@/components/onboarding/wms-onboarding-connection'
import type { IntegrationPluginState } from '@/lib/integration-plugins'
import { isIntegrationsStepReady } from '@/lib/domain/onboarding/integrations-step-readiness'
import { WMS_CONNECTOR_IDS } from '@/lib/connectors/wms/types'
import type { ShoppingConnectorCredentials } from '@/app/actions/shopping-sync'
import type { AccountingConnectionStatus, AccountingConnectorSettingsMasked } from '@/app/actions/accounting-sync'
import type { WmsOnboardingConnectionData } from '@/app/actions/wms-onboarding'
import type { PublicAppUrlInfo } from '@/lib/public-app-url'

type Props = {
  pluginState: IntegrationPluginState
  wcCredentials: ShoppingConnectorCredentials
  accountingSettings: AccountingConnectorSettingsMasked
  accountingStatus: AccountingConnectionStatus
  wmsConnection: WmsOnboardingConnectionData
  publicAppUrlInfo: PublicAppUrlInfo
  onPluginStateChange: (state: IntegrationPluginState) => void
  onConnectionStateChange: (state: {
    wc?: boolean
    accounting?: boolean
    wms?: boolean
  }) => void
  onReadyChange: (ready: boolean) => void
}

export function IntegrationsStep({
  pluginState: initialPluginState,
  wcCredentials: initialWcCreds,
  accountingSettings: initialAccountingSettings,
  accountingStatus: initialAccountingStatus,
  wmsConnection,
  publicAppUrlInfo,
  onPluginStateChange,
  onConnectionStateChange,
  onReadyChange,
}: Props) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { promptReauth, stepUpDialog } = useStepUpReauth()

  // audit-ohou: run a gated save; if it returns the fresh-auth failure, prompt
  // step-up re-auth and retry once so the connector save isn't a dead end.
  async function withStepUp<T extends MaybeFreshAuthFailure>(run: () => Promise<T>): Promise<T> {
    const result = await run()
    if (isFreshAuthFailure(result) && (await promptReauth())) {
      return run()
    }
    return result
  }

  const [plugins, setPlugins] = useState(initialPluginState)
  const [error, setError] = useState('')
  /**
   * o3d-osl8 round 7, finding 1. Its own state, deliberately not `error`: the connector selection
   * IS SAVED when this is set, and rendering it in the same red line as "your save was rejected"
   * would tell the operator the opposite of what happened. Shown alongside the (unchanged, new)
   * switches, with the recovery that actually applies.
   */
  const [schedulerWarning, setSchedulerWarning] = useState('')
  const [savingPlugins, setSavingPlugins] = useState(false)
  const [savingWc, setSavingWc] = useState(false)
  const [wmsBusy, setWmsBusy] = useState(false)
  const [wmsConnected, setWmsConnected] = useState(wmsConnection.configured)
  const [savingAccountingConnection, setSavingAccountingConnection] = useState(false)
  const [connectingAccounting, setConnectingAccounting] = useState(false)

  // WooCommerce credentials
  const [wcUrl, setWcUrl] = useState(initialWcCreds.url)
  const [wcKey, setWcKey] = useState(initialWcCreds.key)
  const [wcSecret, setWcSecret] = useState(initialWcCreds.secretMasked ? '' : initialWcCreds.secret)
  const [wcSaved, setWcSaved] = useState(false)
  const [wcMessage, setWcMessage] = useState('')


  // Accounting credentials
  const [acClientId, setAcClientId] = useState(initialAccountingSettings.client_id ?? initialAccountingSettings.xero_client_id ?? '')
  const [acClientSecret, setAcClientSecret] = useState(
    initialAccountingSettings.secretMasked
      ? ''
      : (initialAccountingSettings.client_secret ?? initialAccountingSettings.xero_client_secret ?? ''),
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
    setWmsConnected(wmsConnection.configured)
  }, [wmsConnection.configured])

  useEffect(() => {
    setAcClientId(initialAccountingSettings.client_id ?? initialAccountingSettings.xero_client_id ?? '')
    setAcClientSecret(
      initialAccountingSettings.secretMasked
        ? ''
        : (initialAccountingSettings.client_secret ?? initialAccountingSettings.xero_client_secret ?? ''),
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
      setWmsBusy(false)
    }

    window.addEventListener('pageshow', resetTransientBusyState)
    return () => window.removeEventListener('pageshow', resetTransientBusyState)
  }, [])

  function buildNextPlugins(current: IntegrationPluginState, key: keyof IntegrationPluginState, value: boolean): IntegrationPluginState {
    const next = { ...current, [key]: value }
    // o3d-remove-parked-connectors: the two lines that turned the OTHER accounting connector off
    // when one was switched on are gone with QuickBooks. This is the OPTIMISTIC local copy only —
    // the binding rule is `INTEGRATION_PLUGIN_EXCLUSIVITY_GROUPS`, evaluated by both writers under
    // the selection lock against the state the write RESULTS in. With one accounting connector
    // registered there is no pair to mirror here; a second one restores a group entry, and this
    // function then has to mirror it again or the screen will optimistically show a state the
    // writer will refuse.
    return next
  }

  /**
   * o3d-osl8 round 7, finding 1: THE ROLLBACK IS ONLY LEGAL FOR A REFUSAL.
   *
   * `saveOnboardingPluginState` commits every plugin flag in one locked transaction and only then
   * reconciles the crontab. Its old `{ success: false }` covered both halves of that, and this
   * function restored `previousPlugins` for either — so a scheduler failure left the wizard showing
   * the OLD connector while the database, the runtime module gates and the next server render all
   * used the NEW one. During an accounting-connector switch that is the dangerous direction: the
   * operator believes Xero is still selected while QuickBooks is what dispatches.
   *
   * The decision is now `resolvePluginSelectionSaveView`'s — pure, exhaustive over all four
   * outcomes (including the REJECTION, which is not a refusal), and testable on its own. This
   * function only applies what it returns.
   */
  function applySaveView(view: PluginSelectionSaveView) {
    setPlugins(view.plugins)
    setError(view.error)
    setSchedulerWarning(view.schedulerWarning)
    if (view.committed) onPluginStateChange(view.plugins)
    return view.committed
  }

  async function persistPlugins(nextPlugins: IntegrationPluginState, previousPlugins: IntegrationPluginState) {
    const result = await saveOnboardingPluginState(nextPlugins)
    return applySaveView(resolvePluginSelectionSaveView({
      attempt: { kind: 'result', result },
      requested: nextPlugins,
      previous: previousPlugins,
    }))
  }

  function togglePlugin(key: keyof IntegrationPluginState, value: boolean) {
    if (savingPlugins || savingWc || wmsBusy || savingAccountingConnection || connectingAccounting) return
    const previousPlugins = plugins
    const nextPlugins = buildNextPlugins(previousPlugins, key, value)
    setError('')
    setSchedulerWarning('')
    setPlugins(nextPlugins)
    setSavingPlugins(true)
    void (async () => {
      try {
        await persistPlugins(nextPlugins, previousPlugins)
      } catch (e) {
        // THE OUTCOME IS UNKNOWN, so the switches are NOT rolled back (round 7, finding 1, applied
        // to the reject path as well as the return path). A rejected server action is a permission
        // gate throwing, a transaction aborting — or a TRANSPORT failure that lost the reply after
        // the write committed. Restoring `previousPlugins` asserts the first two; it is a claim
        // this component cannot make, and it is wrong exactly when it matters.
        //
        // Nothing is refreshed here either, deliberately: `router.refresh()` reports no completion,
        // so an automatic re-sync of these switches would be indistinguishable from them never
        // having moved, and the operator would have no way to tell which state is stored. The
        // instruction is explicit instead.
        applySaveView(resolvePluginSelectionSaveView({
          attempt: { kind: 'rejected', error: e },
          requested: nextPlugins,
          previous: previousPlugins,
        }))
      } finally {
        setSavingPlugins(false)
      }
    })()
  }

  function handleSaveWcCredentials() {
    if (savingPlugins || savingWc || wmsBusy || savingAccountingConnection || connectingAccounting) return
    setError('')
    setWcSaved(false)
    setWcMessage('')
    setSavingWc(true)
    void (async () => {
      try {
        const result = await withStepUp(() => saveShoppingConnectorCredentials(wcUrl, wcKey, wcSecret))
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

  function handleSaveAccountingConnection() {
    if (savingPlugins || savingWc || wmsBusy || savingAccountingConnection || connectingAccounting) return
    const selectedAccountingConnector = selectedAccountingDef.id
    const selectedAccountingLabel = selectedAccountingDef.label
    setError('')
    setAcSaved(false)
    setAccountingMessage('')
    setSavingAccountingConnection(true)
    void (async () => {
      try {
        const result = await withStepUp(() => saveAccountingConnectionSettings(acClientId, acClientSecret, selectedAccountingConnector))
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
    if (savingPlugins || savingWc || wmsBusy || savingAccountingConnection || connectingAccounting) return
    const selectedAccountingConnector = selectedAccountingDef.id
    const selectedAccountingLabel = selectedAccountingDef.label
    setError('')
    setConnectingAccounting(true)
    void (async () => {
      try {
        const saveResult = await withStepUp(() => saveAccountingConnectionSettings(acClientId, acClientSecret, selectedAccountingConnector))
        if (!saveResult.success) {
          setError(saveResult.error ?? `Failed to save ${selectedAccountingLabel} connection settings`)
          return
        }
        setAcSaved(true)
        setAccountingMessage(saveResult.message ?? `${selectedAccountingLabel} app credentials saved. Redirecting to complete OAuth verification.`)

        const origin = window.location.origin
        const result = await withStepUp(() => connectAccountingConnector(acClientId, acClientSecret, origin, '/onboarding', selectedAccountingConnector))
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

  const hasShoppingConnector = plugins.woocommerce
  // DERIVED from the registry (o3d-remove-parked-connectors). `hasAccountingConnector` was
  // `plugins.xero || plugins.quickbooks` and `accountingLabel` was `plugins.quickbooks ? … : 'Xero'`,
  // so a third registered connector would have been invisible to the first and mislabelled by the
  // second. `selectedAccountingDef` is the ONE value the two save handlers key off, so the connector
  // they write to and the name they put in the operator's message cannot disagree.
  const enabledAccountingDef = ACCOUNTING_CONNECTORS.find((connector) => plugins[connector.id])
  const hasAccountingConnector = !!enabledAccountingDef
  const selectedAccountingDef = enabledAccountingDef ?? ACCOUNTING_CONNECTORS[0]
  const wmsEnabled = WMS_CONNECTOR_IDS.some((id) => plugins[id])
  const accountingLabel = selectedAccountingDef.label
  const hasPublicAppUrl = Boolean(publicAppUrlInfo.value)
  const hasSavedAccountingSecret = initialAccountingSettings.secretMasked
  const hasAccountingSecret = Boolean(acClientSecret.trim()) || hasSavedAccountingSecret
  const busy = savingPlugins || savingWc || wmsBusy || savingAccountingConnection || connectingAccounting
  const availableWmsOrderLookupConnectors = [
    plugins.woocommerce ? 'woocommerce' : null,
  ].filter((value): value is 'woocommerce' => value !== null)
  const wcConnected = wcSaved || (!!initialWcCreds.url && !!initialWcCreds.key && initialWcCreds.secretMasked)
  const accountingConnected = accountingConnectedLocal || initialAccountingStatus.connected
  const wcConnectedLabel = wcUrl.trim() || initialWcCreds.url || 'WooCommerce store'
  const accountingConnectedLabel = initialAccountingStatus.tenantName || accountingLabel

  useEffect(() => {
    // THE RULE LIVES IN lib/domain/onboarding/integrations-step-readiness.ts (round 8, Codex HIGH 1,
    // one layer out). It was written out here, inside an effect the render harness never runs, so
    // nothing could exercise it — and the WMS arm of it is what turned a mis-reported `configured`
    // into a wizard that could not be completed at all.
    onReadyChange(isIntegrationsStepReady(plugins, {
      woocommerce: wcConnected,
      accounting: accountingConnected,
      wms: wmsConnected,
    }))
  }, [
    accountingConnected,
    wmsConnected,
    wmsEnabled,
    onReadyChange,
    plugins,
    wcConnected,
  ])

  return (
    <div className="space-y-6">
      {stepUpDialog}
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
              <a
                href="/help/woocommerce"
                target="_blank"
                rel="noopener noreferrer"
                className="sm:col-span-2 text-xs text-primary hover:underline inline-flex items-center gap-1 w-fit"
              >
                How to get your WooCommerce API keys <ExternalLink className="h-3 w-3" />
              </a>
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
                  <a
                    href="/help/xero-sync"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="sm:col-span-2 text-xs text-primary hover:underline inline-flex items-center gap-1 w-fit"
                  >
                    How to get your Xero Client ID &amp; Secret <ExternalLink className="h-3 w-3" />
                  </a>
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

        <WmsOnboardingConnection
          data={wmsConnection}
          enabled={plugins[wmsConnection.connectorId]}
          busy={busy}
          availableOrderLookupConnectors={availableWmsOrderLookupConnectors}
          withStepUp={withStepUp}
          onToggle={(value) => togglePlugin(wmsConnection.connectorId, value)}
          onBusyChange={setWmsBusy}
          onConnected={() => {
            setWmsConnected(true)
            onConnectionStateChange({ wms: true })
          }}
          onError={setError}
        />

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
      {/* Amber, not destructive, and worded as "saved, but": the selection above is durable and the
          switches show it. Only the scheduler is behind. */}
      {schedulerWarning && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">{schedulerWarning}</p>
      )}

      {!hasShoppingConnector && !hasAccountingConnector && !wmsEnabled && (
        <p className="text-sm text-muted-foreground italic">
          No integrations selected. You can enable them at any time from Settings.
        </p>
      )}
    </div>
  )
}
