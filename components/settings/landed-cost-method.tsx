'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { setSetting } from '@/app/actions/settings'

const METHODS = [
  { value: 'BY_VALUE', label: 'By Value', description: 'Costs distributed proportionally to each line\u2019s value' },
  { value: 'BY_QUANTITY', label: 'By Quantity', description: 'Costs distributed proportionally to each line\u2019s quantity' },
  { value: 'BY_WEIGHT', label: 'By Weight', description: 'Costs distributed proportionally to each product\u2019s weight' },
  { value: 'EQUAL_SPLIT', label: 'Equal Split', description: 'Costs split equally across all line items' },
]

type Props = { currentMethod: string }

export function LandedCostMethodSetting({ currentMethod }: Props) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [method, setMethod] = useState(currentMethod)
  const [saved, setSaved] = useState(false)

  function handleSave() {
    setSaved(false)
    startTransition(async () => {
      await setSetting('default_landed_cost_method', method)
      router.refresh()
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    })
  }

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        {METHODS.map((m) => (
          <label key={m.value} className="flex items-start gap-3 cursor-pointer">
            <input
              type="radio"
              name="landedCostMethod"
              value={m.value}
              checked={method === m.value}
              onChange={() => setMethod(m.value)}
              className="mt-0.5"
            />
            <div>
              <span className="text-sm font-medium">{m.label}</span>
              <p className="text-xs text-muted-foreground">{m.description}</p>
            </div>
          </label>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={handleSave} disabled={isPending || method === currentMethod}>
          {isPending && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
          Save
        </Button>
        {saved && <span className="text-xs text-green-600">Saved</span>}
      </div>
    </div>
  )
}
