import Link from 'next/link'
import { Package } from 'lucide-react'

interface ProductThumbProps {
  productId: string
  imageUrl?: string | null
  name?: string
}

export function ProductThumb({ productId, imageUrl, name }: ProductThumbProps) {
  return (
    <Link href={`/inventory/${productId}`} target="_blank" className="block shrink-0" onClick={(e) => e.stopPropagation()}>
      {imageUrl ? (
        <img
          src={imageUrl}
          alt={name ?? ''}
          width={36}
          height={36}
          className="h-9 w-9 rounded object-cover border border-border bg-muted"
        />
      ) : (
        <span className="flex h-9 w-9 items-center justify-center rounded border border-border bg-muted text-muted-foreground">
          <Package className="h-4 w-4" />
        </span>
      )}
    </Link>
  )
}
