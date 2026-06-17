import type { Metadata } from 'next'
import { AlertTriangle, FileText, ShieldAlert, Truck } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { getSetting } from '@/app/actions/settings'
import { getRecentInvoicePdfTokenSecurityEvents, getRecentTaxRateFallbackEvents } from '@/app/actions/activity-log'
import { InvoiceTriggerSetting } from '@/components/settings/invoice-trigger'
import { DeliveryTrackingSettings } from '@/components/settings/delivery-tracking'
import { isIntegrationPluginEnabled } from '@/lib/integration-plugins'
import { formatDateTime } from '@/lib/format-datetime'
import { getDisplayTimeZone } from '@/lib/display-timezone'

export const metadata: Metadata = { title: 'Sales Settings' }

export default async function SalesSettingsPage() {
  const [
    invoiceTrigger,
    trackingEnabled,
    trackingSource,
    trackshipKey,
    carriersJson,
    woocommerceEnabled,
    recentTaxFallbackEvents,
    recentInvoicePdfTokenSecurityEvents,
  ] = await Promise.all([
    getSetting('invoice_trigger'),
    getSetting('delivery_tracking_enabled'),
    getSetting('delivery_tracking_source'),
    getSetting('trackship_api_key'),
    getSetting('shipping_carriers'),
    isIntegrationPluginEnabled('woocommerce'),
    getRecentTaxRateFallbackEvents(5),
    getRecentInvoicePdfTokenSecurityEvents(5),
  ])
  const tz = await getDisplayTimeZone()

  let carriers: string[] = []
  try { carriers = carriersJson ? JSON.parse(carriersJson) : [] } catch { /* empty */ }

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="text-2xl font-semibold">Sales Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">Invoice generation, shipping carriers and delivery tracking.</p>
      </div>

      <Card className="p-6">
        <div className="flex items-center gap-2 mb-4">
          <FileText className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-base font-semibold">Invoice Generation</h2>
        </div>
        <p className="text-sm text-muted-foreground mb-4">
          Configure when sales order invoices are automatically generated.
        </p>
        <InvoiceTriggerSetting currentValue={invoiceTrigger ?? 'manual'} />
      </Card>

      {woocommerceEnabled && (
        <Card className="p-6">
          <div className="flex items-center gap-2 mb-4">
            <Truck className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-base font-semibold">Shipping & Delivery Tracking</h2>
          </div>
          <p className="text-sm text-muted-foreground mb-4">
            Configure shipping carriers and delivery tracking for the active shopping connector.
          </p>
          <DeliveryTrackingSettings
            enabled={trackingEnabled === 'true'}
            source={trackingSource ?? 'shopping_connector'}
            apiKey={trackshipKey ?? ''}
            carriers={carriers}
            allowShoppingConnectorSource
          />
        </Card>
      )}

      <Card className="p-6">
        <div className="flex items-center gap-2 mb-4">
          <AlertTriangle className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-base font-semibold">Recent Tax Rate Fallbacks</h2>
        </div>
        {recentTaxFallbackEvents.length === 0 ? (
          <p className="text-sm text-muted-foreground">No recent tax-rate fallback events.</p>
        ) : (
          <div className="space-y-3">
            {recentTaxFallbackEvents.map((event) => (
              <div key={event.id} className="rounded-md border p-3">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-medium">{event.description}</p>
                  <span className={event.level === 'ERROR' ? 'text-xs font-medium text-destructive' : 'text-xs text-muted-foreground'}>
                    {event.level}
                  </span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {formatDateTime(event.createdAt, undefined, tz)} · {event.action}
                </p>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card className="p-6">
        <div className="flex items-center gap-2 mb-4">
          <ShieldAlert className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-base font-semibold">Recent Invoice PDF Token Security Signals</h2>
        </div>
        {recentInvoicePdfTokenSecurityEvents.length === 0 ? (
          <p className="text-sm text-muted-foreground">No recent copied-session or changed-IP invoice PDF token events.</p>
        ) : (
          <div className="space-y-3">
            {recentInvoicePdfTokenSecurityEvents.map((event) => (
              <div key={event.orderId} className="rounded-md border p-3">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-medium">Sales order {event.orderId}</p>
                  <span className="text-xs font-medium text-destructive">{event.eventCount} warning{event.eventCount === 1 ? '' : 's'}</span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {event.wrongSessionCount} session mismatch - {event.wrongIpCount} IP mismatch - latest {formatDateTime(event.latestAt, undefined, tz)}
                </p>
                <p className="mt-2 text-xs text-muted-foreground">{event.latestDescription}</p>
                {event.userAgents.length > 0 && (
                  <p className="mt-2 truncate text-xs text-muted-foreground">
                    User agents: {event.userAgents.slice(0, 3).join(' - ')}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  )
}
