'use client'

import { useState } from 'react'
import { ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { fetchShoppingProductLink } from '@/app/actions/shopping'

export function ShoppingProductLinkButton({ sku }: { sku: string }) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleClick() {
    setLoading(true)
    setError(null)
    try {
      const result = await fetchShoppingProductLink(sku)
      setLoading(false)
      if (result.error || !result.link?.url) {
        setError(result.error ?? 'No external product link found')
        return
      }
      window.open(result.link.url, '_blank', 'noopener,noreferrer')
    } catch {
      setError('An unexpected error occurred.')
      setLoading(false)
    }
  }

  return (
    <div className="flex flex-col items-start gap-0.5">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={handleClick}
        disabled={loading}
        title="Open product in shopping connector"
      >
        <ExternalLink className="h-3.5 w-3.5 mr-1.5" />
        {loading ? 'Loading…' : 'View in Store'}
      </Button>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}
