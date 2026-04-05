'use client'

import { useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Trash2, UserX } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { deleteOrDeactivateVariant } from '@/app/actions/products'

type Props = {
  variantId: string
  variantSku: string
  parentId: string | null
}

export function DeleteVariantButton({ variantId, variantSku, parentId }: Props) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  function handleClick() {
    if (!confirm(`Delete variant ${variantSku}?\n\nThis cannot be undone.`)) return
    startTransition(async () => {
      const result = await deleteOrDeactivateVariant(variantId, false)
      if (result.action === 'deleted') {
        router.push(parentId ? `/inventory/${parentId}` : '/inventory')
      } else if (result.error === 'HAS_ACTIVITY') {
        if (confirm(
          `${variantSku} has order or stock activity and cannot be deleted.\n\nDeactivate it instead?`
        )) {
          await deleteOrDeactivateVariant(variantId, true)
          router.refresh()
        }
      } else {
        alert(result.error ?? 'Unexpected error')
      }
    })
  }

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={handleClick}
      disabled={isPending}
      className="text-destructive border-destructive/40 hover:bg-destructive/10"
    >
      <Trash2 className="h-3.5 w-3.5 mr-1.5" />
      {isPending ? 'Working…' : 'Delete Variant'}
    </Button>
  )
}
