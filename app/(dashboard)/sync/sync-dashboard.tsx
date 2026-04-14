'use client'

import { Card } from '@/components/ui/card'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { useRouter, useSearchParams } from 'next/navigation'
import { SyncClient } from './sync-client'
import { XeroClient } from './xero-client'
import type { WcSyncSettings, TaxRateMappingRow, StatusMappingRow, SyncLogRow } from '@/app/actions/wc-sync'
import type { XeroSettings, XeroSyncLogRow, XeroSyncReadiness } from '@/app/actions/xero-sync'
import type { DailyBatchPreview, DailyBatchHistoryDay } from '@/app/actions/xero-daily-batch'
import type { TaxRateRow } from '@/app/actions/settings'

type XeroAccount = { id: string; xeroId: string; code: string | null; name: string; type: string }

type Props = {
  wcSettings: WcSyncSettings
  wcTaxMappings: TaxRateMappingRow[]
  wcStatusMappings: StatusMappingRow[]
  wcLogs: SyncLogRow[]
  taxRates: { id: string; name: string }[]
  /** Full IMS VAT rate rows (used by the Xero tax code mapping UI). */
  imsTaxRates: TaxRateRow[]
  /** Live Xero tax rates (fetched on page load when connected). */
  xeroTaxRates: Array<{ taxType: string; name: string; rate: number }>
  wcCredentials: { url: string; key: string; secret: string; secretMasked: boolean }
  xeroSettings: XeroSettings & { secretMasked: boolean }
  xeroConnected: boolean
  xeroTenantName?: string
  xeroAccounts: XeroAccount[]
  xeroLogs: XeroSyncLogRow[]
  paymentMethodCombos: Array<{ paymentMethod: string; currency: string }>
  paymentAccountMap: string
  currencies: Array<{ code: string; name: string }>
  /** Active WooCommerce payment gateways — used to populate the method dropdown in Xero payment mapping. */
  wcPaymentGateways: Array<{ id: string; title: string }>
  xeroReadiness: XeroSyncReadiness
  dailyBatchPreview: DailyBatchPreview
  dailyBatchHistory: DailyBatchHistoryDay[]
}

type ConnectorDef = {
  id: string
  name: string
  description: string
  logo: string // SVG inline or URL
  category: 'shopping' | 'accounting'
  available: boolean
}

const CONNECTORS: ConnectorDef[] = [
  {
    id: 'woocommerce',
    name: 'WooCommerce',
    description: 'Sync orders, products and stock with WooCommerce',
    logo: '/images/woocommerce.svg',
    category: 'shopping',
    available: true,
  },
  {
    id: 'shopify',
    name: 'Shopify',
    description: 'Sync orders, products and stock with Shopify',
    logo: '/images/shopify-banner.png',
    category: 'shopping',
    available: false,
  },
  {
    id: 'rest-api',
    name: 'REST API',
    description: 'Integrate any system via the One Two Inventory REST API',
    logo: '',
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
  {
    id: 'quickbooks',
    name: 'QuickBooks',
    description: 'Sync invoices, COGS journals and purchase invoices',
    logo: '/images/qb-logo-stacked.svg',
    category: 'accounting',
    available: false,
  },
]

const CONNECTOR_LOGOS: Record<string, React.ReactNode> = {
  // eslint-disable-next-line @next/next/no-img-element
  woocommerce: <img src="/images/woocommerce.svg" alt="WooCommerce" className="h-8 object-contain" />,
  // eslint-disable-next-line @next/next/no-img-element
  shopify: <img src="/images/shopify-banner.png" alt="Shopify" className="h-8 object-contain" />,
  'rest-api': (
    <div className="h-8 flex items-center gap-2">
      <svg viewBox="0 0 24 24" className="h-7 w-7 text-primary" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M16 18l6-6-6-6" /><path d="M8 6l-6 6 6 6" />
      </svg>
      <span className="text-base font-bold tracking-tight">REST API</span>
    </div>
  ),
  // eslint-disable-next-line @next/next/no-img-element
  xero: <img src="/images/xero.svg" alt="Xero" className="h-8 object-contain" />,
  // eslint-disable-next-line @next/next/no-img-element
  quickbooks: <img src="/images/qb-logo-stacked.svg" alt="QuickBooks" className="h-8 object-contain" />,
}

export function SyncDashboard({ wcSettings, wcTaxMappings, wcStatusMappings, wcLogs, taxRates, imsTaxRates, xeroTaxRates, wcCredentials, xeroSettings, xeroConnected, xeroTenantName, xeroAccounts, xeroLogs, paymentMethodCombos, paymentAccountMap, currencies, wcPaymentGateways, xeroReadiness, dailyBatchPreview, dailyBatchHistory }: Props) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const activeConnector = searchParams.get('connector')

  function setActiveConnector(id: string | null) {
    if (id) {
      router.push(`/sync?connector=${id}`, { scroll: false })
    } else {
      router.push('/sync', { scroll: false })
    }
  }

  const wcConnected = !!wcCredentials.url && !!wcCredentials.key && !!wcCredentials.secret

  if (activeConnector === 'rest-api') {
    const baseUrl = typeof window !== 'undefined' ? window.location.origin : ''
    const endpoints = [
      { method: 'GET', path: '/api/v1/products', description: 'List all products' },
      { method: 'GET', path: '/api/v1/products/:id', description: 'Get product by ID' },
      { method: 'GET', path: '/api/v1/stock-levels', description: 'List stock levels across warehouses' },
      { method: 'GET', path: '/api/v1/orders', description: 'List sales orders' },
      { method: 'GET', path: '/api/v1/orders/:id', description: 'Get order by ID' },
      { method: 'POST', path: '/api/v1/orders', description: 'Create a sales order' },
      { method: 'PUT', path: '/api/v1/orders/:id/status', description: 'Update order status' },
      { method: 'GET', path: '/api/v1/warehouses', description: 'List warehouses' },
      { method: 'GET', path: '/api/v1/customers', description: 'List customers' },
      { method: 'POST', path: '/api/v1/stock-adjustments', description: 'Adjust stock levels' },
    ]
    return (
      <div className="space-y-4">
        <button type="button" onClick={() => setActiveConnector(null)} className="text-sm text-muted-foreground hover:text-foreground flex items-center gap-1">
          ← Back to Integrations
        </button>
        <div className="flex items-center gap-3 mb-2">
          {CONNECTOR_LOGOS['rest-api']}
          <div>
            <h2 className="text-lg font-semibold">REST API</h2>
            <p className="text-xs text-muted-foreground">Integrate any external system with the One Two Inventory API</p>
          </div>
        </div>

        <Card className="p-6 space-y-4">
          <h3 className="text-base font-semibold">Authentication</h3>
          <p className="text-sm text-muted-foreground">
            All API requests require a Bearer token. Generate an API key in Settings → User Management, then include it in the <code className="bg-muted px-1.5 py-0.5 rounded text-xs font-mono">Authorization</code> header.
          </p>
          <div className="bg-muted/50 rounded-lg p-4 font-mono text-xs space-y-1">
            <p className="text-muted-foreground"># Example request</p>
            <p>curl -H &quot;Authorization: Bearer YOUR_API_KEY&quot; \</p>
            <p className="pl-5">{baseUrl}/api/v1/products</p>
          </div>
        </Card>

        <Card className="p-6 space-y-4">
          <h3 className="text-base font-semibold">Available Endpoints</h3>
          <p className="text-sm text-muted-foreground">
            Base URL: <code className="bg-muted px-1.5 py-0.5 rounded text-xs font-mono">{baseUrl}/api/v1</code>
          </p>
          <Table className="rounded-md border">
            <TableHeader className="bg-muted/50">
              <TableRow>
                <TableHead className="text-xs w-20">Method</TableHead>
                <TableHead className="text-xs">Endpoint</TableHead>
                <TableHead className="text-xs">Description</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {endpoints.map((e, i) => (
                <TableRow key={i}>
                  <TableCell>
                    <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-mono font-medium ${e.method === 'GET' ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200' : e.method === 'POST' ? 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200' : 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200'}`}>
                      {e.method}
                    </span>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{e.path}</TableCell>
                  <TableCell className="text-muted-foreground">{e.description}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <p className="text-xs text-muted-foreground">
            All responses return JSON. List endpoints support <code className="bg-muted px-1 rounded">?limit</code> and <code className="bg-muted px-1 rounded">?offset</code> pagination.
            The API is under active development — additional endpoints will be added.
          </p>
        </Card>
      </div>
    )
  }

  if (activeConnector === 'xero') {
    return (
      <div className="space-y-4">
        <button type="button" onClick={() => setActiveConnector(null)} className="text-sm text-muted-foreground hover:text-foreground flex items-center gap-1">
          ← Back to Integrations
        </button>
        <div className="flex items-center gap-3 mb-2">
          {CONNECTOR_LOGOS.xero}
          <div>
            <h2 className="text-lg font-semibold">Xero Connector</h2>
            <p className="text-xs text-muted-foreground">Sync invoices, journals, and bills to Xero</p>
          </div>
        </div>
        <XeroClient
          settings={xeroSettings}
          connected={xeroConnected}
          tenantName={xeroTenantName}
          accounts={xeroAccounts}
          logs={xeroLogs}
          paymentMethodCombos={paymentMethodCombos}
          paymentAccountMap={paymentAccountMap}
          currencies={currencies}
          wcPaymentGateways={wcPaymentGateways}
          imsTaxRates={imsTaxRates}
          xeroTaxRates={xeroTaxRates}
          readiness={xeroReadiness}
          dailyBatchPreview={dailyBatchPreview}
          dailyBatchHistory={dailyBatchHistory}
        />
      </div>
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
          settings={wcSettings}
          taxMappings={wcTaxMappings}
          statusMappings={wcStatusMappings}
          logs={wcLogs}
          taxRates={taxRates}
          wcCredentials={wcCredentials}
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
          {CONNECTORS.filter((c) => c.category === 'shopping').map((c) => (
            <Card
              key={c.id}
              className={`p-5 space-y-3 transition-colors ${c.available ? 'cursor-pointer hover:border-primary/50' : 'opacity-50'}`}
              onClick={() => c.available && setActiveConnector(c.id)}
            >
              <div className="flex items-center justify-between">
                {CONNECTOR_LOGOS[c.id]}
                {c.id === 'woocommerce' && wcConnected && (
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

      {/* Accounting Connectors */}
      <div>
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">Accounting</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {CONNECTORS.filter((c) => c.category === 'accounting').map((c) => (
            <Card
              key={c.id}
              className={`p-5 space-y-3 transition-colors ${c.available ? 'cursor-pointer hover:border-primary/50' : 'opacity-50'}`}
              onClick={() => c.available && setActiveConnector(c.id)}
            >
              <div className="flex items-center justify-between">
                {CONNECTOR_LOGOS[c.id]}
                {c.id === 'xero' && xeroConnected && (
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
