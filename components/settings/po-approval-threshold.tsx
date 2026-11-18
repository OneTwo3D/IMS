'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { setPoApprovalThreshold } from '@/app/actions/purchase-orders'

type Props = { currentValue: string; baseCurrency: string }

export function PoApprovalThresholdSetting({ currentValue, baseCurrency }: Props) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [value, setValue] = useState(currentValue)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')

  function handleSave() {
    setSaved(false)
    setError('')
    startTransition(async () => {
      const result = await setPoApprovalThreshold(value)
      if (!result.success) {
        setError(result.error ?? 'Could not save')
        return
      }
      router.refresh()
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    })
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Input
          inputMode="decimal"
          className="h-8 w-40"
          placeholder="No approval needed"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          aria-label={`Approval threshold in ${baseCurrency}`}
        />
        <span className="text-sm text-muted-foreground">{baseCurrency}, ex VAT</span>
      </div>
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={handleSave} disabled={isPending || value.trim() === currentValue}>
          {isPending && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}Save
        </Button>
        {saved && <span className="text-xs text-green-600">Saved</span>}
        {error && <span className="text-xs text-red-600">{error}</span>}
      </div>
    </div>
  )
}
