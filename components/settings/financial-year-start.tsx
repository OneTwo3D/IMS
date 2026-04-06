'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { setSetting } from '@/app/actions/settings'

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

export function FinancialYearStartSetting({ currentValue }: { currentValue: string }) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [month, setMonth] = useState(currentValue.split('-')[0] ?? '04')
  const [day, setDay] = useState(currentValue.split('-')[1] ?? '06')

  const daysInMonth = new Date(2024, Number(month), 0).getDate() // 2024 is a leap year for Feb

  function handleSave() {
    const value = `${month.padStart(2, '0')}-${day.padStart(2, '0')}`
    startTransition(async () => {
      await setSetting('financial_year_start', value)
      router.refresh()
    })
  }

  const currentFormatted = `${Number(day)} ${MONTHS[Number(month) - 1]}`

  return (
    <div className="flex items-center gap-3">
      <div className="flex items-center gap-2">
        <select
          value={day}
          onChange={(e) => setDay(e.target.value)}
          className="h-9 rounded-md border border-input bg-background px-3 text-sm w-20"
        >
          {Array.from({ length: daysInMonth }, (_, i) => (
            <option key={i + 1} value={String(i + 1).padStart(2, '0')}>{i + 1}</option>
          ))}
        </select>
        <select
          value={month}
          onChange={(e) => { setMonth(e.target.value); if (Number(day) > new Date(2024, Number(e.target.value), 0).getDate()) setDay('01') }}
          className="h-9 rounded-md border border-input bg-background px-3 text-sm"
        >
          {MONTHS.map((m, i) => (
            <option key={i} value={String(i + 1).padStart(2, '0')}>{m}</option>
          ))}
        </select>
      </div>
      <Button size="sm" onClick={handleSave} disabled={isPending}>
        {isPending && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
        Save
      </Button>
      <span className="text-xs text-muted-foreground">Currently: {currentFormatted}</span>
    </div>
  )
}
