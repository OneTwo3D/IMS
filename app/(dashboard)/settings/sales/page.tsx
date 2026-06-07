import type { Metadata } from 'next'
import { AlertTriangle, FileText, Truck } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { getSetting } from '@/app/actions/settings'
import { getRecentTaxRateFallbackEvents } from '@/app/actions/activity-log'
import { InvoiceTriggerSetting } from '@/components/settings/invoice-trigger'
import { DeliveryTrackingSettings } from '@/components/settings/delivery-tracking'
import { isIntegrationPluginEnabled } from '@/lib/integration-plugins'

export const metadata: Metadata = { title: 'Sales Settings' }

export default async function SalesSettingsPage() {
  const [invoiceTrigger, trackingEnabled, trackingSource, trackshipKey, carriersJson, woocommerceEnabled, recentTaxFallbackEvents] = await Promise.all([
    getSetting('invoice_trigger'),
    getSetting('delivery_tracking_enabled'),
    getSetting('delivery_tracking_source'),
    getSetting('trackship_api_key'),
    getSetting('shipping_carriers'),
    isIntegrationPluginEnabled('woocommerce'),
    getRecentTaxRateFallbackEvents(5),
  ])

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
                  {new Date(event.createdAt).toLocaleString()} · {event.action}
                </p>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  )
}
