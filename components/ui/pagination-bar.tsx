'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { buttonVariants } from '@/components/ui/button-variants'

type Props = {
  page: number
  totalPages: number
  buildHref: (p: number) => string
}

export function PaginationBar({ page, totalPages, buildHref }: Props) {
  const [jumpPage, setJumpPage] = useState('')

  if (totalPages <= 1) return null

  function handleJump() {
    const p = parseInt(jumpPage, 10)
    if (!p || p < 1 || p > totalPages || p === page) return
    window.location.href = buildHref(p)
  }

  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-muted-foreground">
        Page {page} of {totalPages}
      </span>
      <div className="flex items-center gap-2">
        {page > 1 && (
          <Link
            href={buildHref(page - 1)}
            className={buttonVariants({ variant: 'outline', size: 'sm' })}
          >
            Previous
          </Link>
        )}

        <form
          onSubmit={(e) => { e.preventDefault(); handleJump() }}
          className="flex items-center gap-1"
        >
          <Input
            type="number"
            min={1}
            max={totalPages}
            value={jumpPage}
            onChange={(e) => setJumpPage(e.target.value)}
            placeholder={String(page)}
            className="w-16 h-8 text-center text-sm"
          />
          <Button type="submit" variant="outline" size="sm">
            Go
          </Button>
        </form>

        {page < totalPages && (
          <Link
            href={buildHref(page + 1)}
            className={buttonVariants({ variant: 'outline', size: 'sm' })}
          >
            Next
          </Link>
        )}
      </div>
    </div>
  )
}
