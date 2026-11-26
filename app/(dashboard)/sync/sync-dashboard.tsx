'use client'

import { Card } from '@/components/ui/card'
import { useRouter, useSearchParams } from 'next/navigation'
import { SyncClient } from './sync-client'
import { WMS_PANEL_ENTRIES, WmsSyncPanel, listWmsIntegrationCards } from './wms-sync-panel'
import { AccountingConnectorPanel, isAccountingConnectorUiId } from './accounting-connector-panel'
import { isWmsConnectorId, type WmsConnectorId } from '@/lib/connectors/wms/types'
import type { WmsSyncDashboardData } from '@/app/actions/wms-sync'
import type {
  ShoppingConnectorCredentials,
  ShoppingStatusMappingRow,
  ShoppingSyncLogRow,
  ShoppingSyncSettings,
  ShoppingTaxRateMappingRow,
} from '@/app/actions/shopping-sync'
import type {
  AccountingAccountRow,
  AccountingConnectorSettings,
  AccountingSyncLogRow,
  AccountingSyncReadiness,
} from '@/app/actions/accounting-sync'
import type { AccountingBatchHistoryDay, AccountingBatchPreview } from '@/app/actions/accounting-batch'
import type { TaxRateRow } from '@/app/actions/settings'
import type { IntegrationPluginState } from '@/lib/integration-plugins'
import type { IntegrationConnectionTestState } from '@/lib/integration-connection-test-gate'

type Props = {
  pluginState: IntegrationPluginState
  shoppingSettings: ShoppingSyncSettings
  shoppingTaxMappings: ShoppingTaxRateMappingRow[]
  shoppingStatusMappings: ShoppingStatusMappingRow[]
  shoppingLogs: ShoppingSyncLogRow[]
  taxRates: { id: string; name: string }[]
  /** Full IMS VAT rate rows (used by the accounting tax code mapping UI). */
  imsTaxRates: TaxRateRow[]
  /** Live accounting tax rates (fetched on page load when connected). */
  accountingTaxRates: Array<{ taxType: string; name: string; rate: number }>
  shoppingCredentials: ShoppingConnectorCredentials
  accountingSettings: AccountingConnectorSettings & { secretMasked: boolean }
  accountingConnected: boolean
  accountingTenantName?: string
  accountingBlockedReason?: string
  accountingHasStoredToken?: boolean
  accountingConnectionTest: IntegrationConnectionTestState
  accountingAccounts: AccountingAccountRow[]
  accountingLogs: AccountingSyncLogRow[]
  paymentMethodCombos: Array<{ paymentMethod: string; currency: string }>
  paymentAccountMap: string
  currencies: Array<{ code: string; name: string }>
  /** Active shopping connector payment methods — used to populate the method dropdown in accounting payment mapping. */
  shoppingPaymentMethods: Array<{ id: string; title: string }>
  accountingReadiness: AccountingSyncReadiness
  accountingBatchPreview: AccountingBatchPreview
  accountingBatchHistory: AccountingBatchHistoryDay[]
  wmsData: WmsSyncDashboardData | null
  /**
   * The WMS connectors this build OFFERS — read from `WmsConnectorDef.available` on the server
   * (wms-neutral-refactor round 12, Codex HIGH 2).
   *
   * The WMS cards used to be built with `available: true` written out here, which is a SECOND
   * source for a fact the registry already states: a connector staged as not-offered got a live,
   * clickable card anyway. It is a prop rather than an import because the registry statically pulls
   * the shipped connector (and Prisma behind it) and cannot enter a client bundle — the same reason
   * the plugin descriptors are passed down.
   */
  availableWmsConnectorIds: readonly WmsConnectorId[]
  /**
   * The WMS connectors that are enabled when MORE THAN ONE is (wms-neutral-refactor round 12,
   * Codex MEDIUM) — empty in every other state.
   *
   * Ambiguity resolves to no active connector on purpose, so `wmsData` is `null`; without the ids
   * the panel could only say "another connector currently does", which is the one sentence that is
   * certainly false in the one state that reaches it.
   */
  ambiguousWmsConnectorIds: readonly string[]
}

type ConnectorDef = {
  id: string
  name: string
  description: string
  logo: string // SVG inline or URL
  category: 'shopping' | 'accounting'
    | 'wms'
  available: boolean
}

const NON_WMS_CONNECTORS: ConnectorDef[] = [
  {
    id: 'woocommerce',
    name: 'WooCommerce',
    description: 'Sync orders, products and stock with WooCommerce',
    logo: '/images/woocommerce.svg',
    category: 'shopping',
    available: true,
  },
  {
    id: 'xero',
    name: 'Xero',
    description: 'Sync invoices, COGS journals and purchase invoices',
    logo: '/images/xero.svg',
    category: 'accounting',
    available: true,
  },
]

/**
 * wms-neutral-refactor round 6 (Codex HIGH 1) — THE WMS CARDS ARE DERIVED, NOT LISTED.
 * A hand-written entry per connector is the same one-arm shape as the panel dispatch it sits next
 * to: a registered, enabled second connector that nobody remembered to add here gets no card at
 * all, so the Warehouse Management section is empty and the connector is unreachable from the UI —
 * silently, with nothing on screen to say so. `WMS_PANEL_ENTRIES` is built from the total
 * `Record<WmsConnectorId, …>` in wms-sync-panel.tsx, so every registered id has a card and a panel
 * or the build does not compile.
 *
 * ROUND 12 (Codex HIGH 2) — AND `available` COMES FROM THE REGISTRY. It was written out as
 * `available: true` here, a second source for a fact the connector's own definition already states,
 * so a connector registered `available: false` — "registered but not offered to operators yet" —
 * got a live, clickable card. The list of offered ids is resolved on the server and passed in; this
 * file no longer holds an opinion about it.
 */
function wmsConnectorCards(availableWmsConnectorIds: readonly WmsConnectorId[]): ConnectorDef[] {
  return listWmsIntegrationCards(availableWmsConnectorIds).map((card): ConnectorDef => ({
    ...card,
    logo: '',
    category: 'wms',
  }))
}

const CONNECTOR_LOGOS: Record<string, React.ReactNode> = {
  // eslint-disable-next-line @next/next/no-img-element
  woocommerce: <img src="/images/woocommerce.svg" alt="WooCommerce" className="h-8 object-contain" />,
  // The WMS logos come from the same total record the cards and panels do.
  ...Object.fromEntries(WMS_PANEL_ENTRIES.map((entry) => [entry.id, entry.logo])),
  // eslint-disable-next-line @next/next/no-img-element
  xero: <img src="/images/xero.svg" alt="Xero" className="h-8 object-contain" />,
}

export function SyncDashboard({ pluginState, shoppingSettings, shoppingTaxMappings, shoppingStatusMappings, shoppingLogs, taxRates, imsTaxRates, accountingTaxRates, shoppingCredentials, accountingSettings, accountingConnected, accountingTenantName, accountingBlockedReason, accountingHasStoredToken, accountingConnectionTest, accountingAccounts, accountingLogs, paymentMethodCombos, paymentAccountMap, currencies, shoppingPaymentMethods, accountingReadiness, accountingBatchPreview, accountingBatchHistory, wmsData, availableWmsConnectorIds, ambiguousWmsConnectorIds }: Props) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const requestedConnector = searchParams.get('connector')
  const activeConnector = (
    requestedConnector === 'woocommerce' && !pluginState.woocommerce
  ) || (
    requestedConnector === 'xero' && !pluginState.xero
  ) || (
    // A connector this build does not OFFER has no panel to open, however the URL was arrived at
    // (round 12, Codex HIGH 2). `?connector=` is operator-supplied, and the grid is not the only
    // way in — greying the card out while leaving the deep link live would be the same
    // availability check missing from the second of two places.
    isWmsConnectorId(requestedConnector)
      && (!pluginState[requestedConnector] || !availableWmsConnectorIds.includes(requestedConnector))
  )
    ? null
    : requestedConnector

  function setActiveConnector(id: string | null) {
    if (id) {
      router.push(`/sync?connector=${id}`, { scroll: false })
    } else {
      router.push('/sync', { scroll: false })
    }
  }

  const woocommerceConnected = pluginState.woocommerce && !!shoppingCredentials.url && !!shoppingCredentials.key && !!shoppingCredentials.secret
  const wmsConfigured = Boolean(wmsData?.configured)
  const connectors = [...NON_WMS_CONNECTORS, ...wmsConnectorCards(availableWmsConnectorIds)]
  const visibleConnectors = connectors.filter((connector) => {
    if (connector.id === 'woocommerce') return pluginState.woocommerce
    if (connector.id === 'xero') return pluginState.xero
    if (isWmsConnectorId(connector.id)) return pluginState[connector.id]
    return true
  })

  if (isAccountingConnectorUiId(activeConnector)) {
    return (
      <AccountingConnectorPanel
        connectorId={activeConnector}
        logo={CONNECTOR_LOGOS[activeConnector]}
        onBack={() => setActiveConnector(null)}
        clientProps={{
          settings: accountingSettings,
          connected: accountingConnected,
          tenantName: accountingTenantName,
          blockedReason: accountingBlockedReason,
          hasStoredToken: accountingHasStoredToken,
          connectionTest: accountingConnectionTest,
          accounts: accountingAccounts,
          logs: accountingLogs,
          paymentMethodCombos,
          paymentAccountMap,
          currencies,
          shoppingPaymentMethods,
          imsTaxRates,
          xeroTaxRates: accountingTaxRates,
          readiness: accountingReadiness,
          dailyBatchPreview: accountingBatchPreview,
          dailyBatchHistory: accountingBatchHistory,
        }}
      />
    )
  }

  // EVERY WMS card opens its panel. The old guard also required the DTO to belong to the card that
  // was clicked, so a second enabled connector's card fell through to the grid — a click that did
  // nothing and explained nothing. The panel is total over the cases now, so the mismatch is a
  // state it renders rather than a branch that vanishes (wms-neutral-refactor round 6, Codex HIGH 1).
  if (activeConnector && isWmsConnectorId(activeConnector)) {
    return (
      <WmsSyncPanel
        connectorId={activeConnector}
        data={wmsData}
        ambiguousConnectorIds={ambiguousWmsConnectorIds}
        onBack={() => setActiveConnector(null)}
      />
    )
  }

  if (activeConnector === 'woocommerce') {
    return (
      <div className="space-y-4">
        <button type="button" onClick={() => setActiveConnector(null)} className="text-sm text-muted-foreground hover:text-foreground flex items-center gap-1">
          ← Back to Integrations
        </button>
        <div className="flex items-center gap-3 mb-2">
          {CONNECTOR_LOGOS.woocommerce}
          <div>
            <h2 className="text-lg font-semibold">WooCommerce Connector</h2>
            <p className="text-xs text-muted-foreground">Sync orders, products and stock levels</p>
          </div>
        </div>
        <SyncClient
          settings={shoppingSettings}
          taxMappings={shoppingTaxMappings}
          statusMappings={shoppingStatusMappings}
          logs={shoppingLogs}
          taxRates={taxRates}
          shoppingCredentials={shoppingCredentials}
          accountingConnected={accountingConnected && pluginState.xero}
        />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Shopping Connectors */}
      <div>
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">Shopping Platforms</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {visibleConnectors.filter((c) => c.category === 'shopping').map((c) => (
            <Card
              key={c.id}
              className={`p-5 space-y-3 transition-colors ${c.available ? 'cursor-pointer hover:border-primary/50' : 'opacity-50'}`}
              onClick={() => c.available && setActiveConnector(c.id)}
            >
              <div className="flex items-center justify-between">
                {CONNECTOR_LOGOS[c.id]}
                {c.id === 'woocommerce' && woocommerceConnected && (
                  <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200">
                    Connected
                  </span>
                )}
                {!c.available && (
                  <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-muted text-muted-foreground">
                    Coming Soon
                  </span>
                )}
              </div>
              <p className="text-sm text-muted-foreground">{c.description}</p>
            </Card>
          ))}
        </div>
      </div>

      <div>
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">Warehouse Management</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {visibleConnectors.filter((c) => c.category === 'wms').map((c) => (
            <Card
              key={c.id}
              className={`p-5 space-y-3 transition-colors ${c.available ? 'cursor-pointer hover:border-primary/50' : 'opacity-50'}`}
              onClick={() => c.available && setActiveConnector(c.id)}
            >
              <div className="flex items-center justify-between">
                {CONNECTOR_LOGOS[c.id]}
                {isWmsConnectorId(c.id) && wmsData?.connectorId === c.id && wmsConfigured && (
                  <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200">
                    Configured
                  </span>
                )}
                {!c.available && (
                  <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-muted text-muted-foreground">
                    Coming Soon
                  </span>
                )}
              </div>
              <p className="text-sm text-muted-foreground">{c.description}</p>
            </Card>
          ))}
        </div>
      </div>

      {/* Accounting Connectors */}
      <div>
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">Accounting</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {visibleConnectors.filter((c) => c.category === 'accounting').map((c) => (
            <Card
              key={c.id}
              className={`p-5 space-y-3 transition-colors ${c.available ? 'cursor-pointer hover:border-primary/50' : 'opacity-50'}`}
              onClick={() => c.available && setActiveConnector(c.id)}
            >
              <div className="flex items-center justify-between">
                {CONNECTOR_LOGOS[c.id]}
                {isAccountingConnectorUiId(c.id) && accountingConnected && (
                  <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200">
                    Connected
                  </span>
                )}
                {!c.available && (
                  <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-muted text-muted-foreground">
                    Coming Soon
                  </span>
                )}
              </div>
              <p className="text-sm text-muted-foreground">{c.description}</p>
            </Card>
          ))}
        </div>
      </div>
    </div>
  )
}
