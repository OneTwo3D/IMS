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
        /* eslint-disable-next-line @next/next/no-img-element */
        <img
          src={imageUrl}
          alt={name ?? ''}
          width={36}
          height={36}
          /* max-w-none: Tailwind Preflight caps imgs at max-width:100%, which in a
             squeezed table column collapses the width while h-9 keeps the height,
             rendering a thin vertical strip. shrink-0 keeps it from flexing. */
          className="h-9 w-9 max-w-none shrink-0 rounded object-cover border border-border bg-muted"
        />
      ) : (
        <span className="flex h-9 w-9 max-w-none shrink-0 items-center justify-center rounded border border-border bg-muted text-muted-foreground">
          <Package className="h-4 w-4" />
        </span>
      )}
    </Link>
  )
}
