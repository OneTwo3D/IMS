'use client'

import { useEffect, useState } from 'react'

type Props = {
  active: boolean
  label?: string
  detail?: string
  className?: string
  value?: number
  max?: number
}

export function LoadingProgress({ active, label, detail, className = '', value, max }: Props) {
  const [progress, setProgress] = useState(0)
  const hasDeterminateProgress = typeof value === 'number' && typeof max === 'number' && max > 0
  const determinateProgress = hasDeterminateProgress
    ? Math.min(100, Math.max(0, (value / max) * 100))
    : 0

  useEffect(() => {
    if (!active) return

    const resetTimer = window.setTimeout(() => {
      setProgress(10)
    }, 0)

    const timer = window.setInterval(() => {
      setProgress((current) => {
        if (current >= 92) return current
        const remaining = 92 - current
        return Math.min(92, current + Math.max(1, Math.round(remaining * 0.18)))
      })
    }, 300)

    return () => {
      window.clearTimeout(resetTimer)
      window.clearInterval(timer)
    }
  }, [active])

  if (!active) return null

  return (
    <div className={`w-full space-y-1 ${className}`.trim()}>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-300 ease-out"
          style={{ width: `${hasDeterminateProgress ? determinateProgress : progress}%` }}
        />
      </div>
      {label ? <p className="text-[11px] text-muted-foreground">{label}</p> : null}
      {detail ? <p className="text-[11px] text-muted-foreground">{detail}</p> : null}
    </div>
  )
}
