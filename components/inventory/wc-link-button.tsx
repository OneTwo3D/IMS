'use client'

import { useState } from 'react'
import { ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { fetchWcProductUrl } from '@/lib/connectors/woocommerce/products'

export function WcLinkButton({ sku }: { sku: string }) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleClick() {
    setLoading(true)
    setError(null)
    const result = await fetchWcProductUrl(sku)
    setLoading(false)
    if (result.error || !result.permalink) {
      setError(result.error ?? 'No permalink found')
      return
    }
    window.open(result.permalink, '_blank', 'noopener,noreferrer')
  }

  return (
    <div className="flex flex-col items-start gap-0.5">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={handleClick}
        disabled={loading}
        title="Open product on WooCommerce"
      >
        <ExternalLink className="h-3.5 w-3.5 mr-1.5" />
        {loading ? 'Loading…' : 'View on WooCommerce'}
      </Button>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}
