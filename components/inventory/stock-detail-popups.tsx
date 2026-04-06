'use client'

import { useState, useRef, useEffect, useTransition } from 'react'
import Link from 'next/link'
import { Loader2, ExternalLink, ShoppingCart, Factory, Truck, Package } from 'lucide-react'
import {
  getAllocationDetails,
  getIncomingDetails,
  type AllocationDetail,
  type IncomingDetail,
} from '@/app/actions/products'

type PopupProps = {
  children: React.ReactNode
  productId: string
  warehouseId: string
  type: 'allocated' | 'incoming'
}

export function StockDetailPopup({ children, productId, warehouseId, type }: PopupProps) {
  const [open, setOpen] = useState(false)
  const [isPending, startTransition] = useTransition()
  const [allocations, setAllocations] = useState<AllocationDetail[] | null>(null)
  const [incoming, setIncoming] = useState<IncomingDetail[] | null>(null)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open])

  function handleClick() {
    if (open) { setOpen(false); return }
    setOpen(true)
    startTransition(async () => {
      if (type === 'allocated') {
        const data = await getAllocationDetails(productId, warehouseId)
        setAllocations(data)
      } else {
        const data = await getIncomingDetails(productId, warehouseId)
        setIncoming(data)
      }
    })
  }

  return (
    <div className="relative inline-block" ref={ref}>
      <button type="button" onClick={handleClick} className="cursor-pointer hover:underline">
        {children}
      </button>
      {open && (
        <div className="absolute z-50 right-0 top-full mt-1 w-72 rounded-lg border bg-popover p-2 text-popover-foreground shadow-lg">
          <p className="text-xs font-medium text-muted-foreground mb-2">
            {type === 'allocated' ? 'Allocated To' : 'Incoming From'}
          </p>

          {isPending ? (
            <div className="flex items-center justify-center py-3">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
          ) : type === 'allocated' ? (
            allocations && allocations.length === 0 ? (
              <p className="text-xs text-muted-foreground py-2">No active allocations.</p>
            ) : (
              <div className="space-y-1 max-h-48 overflow-y-auto">
                {allocations?.map((a, i) => (
                  <Link
                    key={`${a.type}-${a.id}-${i}`}
                    href={a.type === 'sales_order' ? `/sales/${a.id}` : `/manufacturing/${a.id}`}
                    className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-muted/50 transition-colors"
                    onClick={() => setOpen(false)}
                  >
                    {a.type === 'sales_order' ? (
                      <ShoppingCart className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    ) : (
                      <Factory className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    )}
                    <div className="flex-1 min-w-0">
                      <span className="font-mono">{a.reference}</span>
                      <span className="text-muted-foreground ml-1">
                        ({a.type === 'sales_order' ? 'SO' : 'MO'})
                      </span>
                    </div>
                    <span className="font-mono font-medium shrink-0">{a.qty}</span>
                    <ExternalLink className="h-3 w-3 text-muted-foreground shrink-0" />
                  </Link>
                ))}
              </div>
            )
          ) : (
            incoming && incoming.length === 0 ? (
              <p className="text-xs text-muted-foreground py-2">No incoming stock.</p>
            ) : (
              <div className="space-y-1 max-h-48 overflow-y-auto">
                {incoming?.map((inc, i) => (
                  <Link
                    key={`${inc.type}-${inc.id}-${i}`}
                    href={inc.type === 'purchase_order' ? `/purchase-orders/${inc.id}` : `/stock-control/transfers`}
                    className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-muted/50 transition-colors"
                    onClick={() => setOpen(false)}
                  >
                    {inc.type === 'purchase_order' ? (
                      <Package className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    ) : (
                      <Truck className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    )}
                    <div className="flex-1 min-w-0">
                      <span className="font-mono">{inc.reference}</span>
                      <span className="text-muted-foreground ml-1">
                        ({inc.type === 'purchase_order' ? 'PO' : 'Transfer'})
                      </span>
                      {inc.expectedDate && (
                        <span className="text-muted-foreground block">
                          ETA: {new Date(inc.expectedDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                        </span>
                      )}
                    </div>
                    <span className="font-mono font-medium text-blue-600 dark:text-blue-400 shrink-0">+{inc.qty}</span>
                    <ExternalLink className="h-3 w-3 text-muted-foreground shrink-0" />
                  </Link>
                ))}
              </div>
            )
          )}
        </div>
      )}
    </div>
  )
}
