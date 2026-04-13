'use client'

import Link from 'next/link'
import { useState } from 'react'
import { usePathname } from 'next/navigation'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { LucideIcon } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

interface NavChild {
  href: string
  label: string
}

interface NavGroupProps {
  label: string
  icon: LucideIcon
  items: NavChild[]
  collapsed?: boolean
  onExpand?: () => void
  onNavigate?: () => void
}

export function NavGroup({ label, icon: Icon, items, collapsed, onExpand, onNavigate }: NavGroupProps) {
  const pathname = usePathname()
  const isChildActive = (c: NavChild) =>
    pathname === c.href || (pathname.startsWith(c.href + '/') && !items.some((other) => other.href !== c.href && pathname.startsWith(other.href)))
  const isAnyChildActive = items.some(isChildActive)
  const [open, setOpen] = useState(isAnyChildActive)
  const [prevActive, setPrevActive] = useState(isAnyChildActive)

  // Auto-open when navigating to a child route (render-time state adjustment)
  if (isAnyChildActive && !prevActive) {
    setPrevActive(true)
    setOpen(true)
  }
  if (!isAnyChildActive && prevActive) {
    setPrevActive(false)
  }

  const parentClass = cn(
    'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors cursor-pointer select-none',
    'hover:bg-accent hover:text-accent-foreground',
    isAnyChildActive ? 'text-accent-foreground' : 'text-muted-foreground',
    collapsed && 'justify-center px-2',
  )

  if (collapsed) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              className={parentClass}
              onClick={() => {
                setOpen(true)
                onExpand?.()
              }}
              aria-label={`Expand ${label}`}
            />
          }
        >
          <Icon className="h-4 w-4 shrink-0" />
        </TooltipTrigger>
        <TooltipContent side="right">{label}</TooltipContent>
      </Tooltip>
    )
  }

  return (
    <div>
      <button
        type="button"
        className={cn(parentClass, 'w-full')}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon className="h-4 w-4 shrink-0" />
        <span className="truncate flex-1 text-left">{label}</span>
        <ChevronDown
          className={cn('h-3.5 w-3.5 shrink-0 transition-transform', open && 'rotate-180')}
        />
      </button>

      {open && (
        <div className="ml-4 mt-0.5 flex flex-col gap-0.5 border-l border-border pl-3">
          {items.map((child) => {
            const isActive = isChildActive(child)
            return (
              <Link
                key={child.href}
                href={child.href}
                onClick={onNavigate}
                className={cn(
                  'rounded-md px-2 py-1.5 text-sm transition-colors',
                  'hover:bg-accent hover:text-accent-foreground',
                  isActive ? 'bg-accent text-accent-foreground font-medium' : 'text-muted-foreground',
                )}
              >
                {child.label}
              </Link>
            )
          })}
        </div>
      )}
    </div>
  )
}
