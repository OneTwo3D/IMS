'use client'

import Link from 'next/link'

interface ProductLinkProps {
  productId: string
  sku: string
  name?: string
  skuClassName?: string
  nameClassName?: string
}

export function ProductLink({ productId, sku, name, skuClassName, nameClassName }: ProductLinkProps) {
  return (
    <Link
      href={`/inventory/${productId}`}
      target="_blank"
      className="group/pl inline-flex items-baseline gap-1.5 hover:underline decoration-muted-foreground underline-offset-2 min-w-0"
      onClick={(e) => e.stopPropagation()}
    >
      <span className={skuClassName ?? 'font-mono text-sm font-medium'}>{sku}</span>
      {name && (
        <span className={nameClassName ?? 'text-xs text-muted-foreground truncate'}>{name}</span>
      )}
    </Link>
  )
}
