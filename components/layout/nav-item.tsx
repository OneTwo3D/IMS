'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'
import type { LucideIcon } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

interface NavItemProps {
  href: string
  label: string
  icon: LucideIcon
  collapsed?: boolean
  badge?: number
  onNavigate?: () => void
}

export function NavItem({ href, label, icon: Icon, collapsed, badge, onNavigate }: NavItemProps) {
  const pathname = usePathname()
  const isActive = pathname === href || pathname.startsWith(href + '/')

  const linkClass = cn(
    'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
    'hover:bg-accent hover:text-accent-foreground',
    isActive ? 'bg-accent text-accent-foreground' : 'text-muted-foreground',
    collapsed && 'justify-center px-2',
  )

  if (collapsed) {
    return (
      <Tooltip>
        <TooltipTrigger render={<Link href={href} className={linkClass} onClick={onNavigate} />}>
          <Icon className="h-4 w-4 shrink-0" />
        </TooltipTrigger>
        <TooltipContent side="right">{label}</TooltipContent>
      </Tooltip>
    )
  }

  return (
    <Link href={href} className={linkClass} onClick={onNavigate}>
      <Icon className="h-4 w-4 shrink-0" />
      <span className="truncate">{label}</span>
      {badge != null && badge > 0 && (
        <span className="ml-auto flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground">
          {badge > 99 ? '99+' : badge}
        </span>
      )}
    </Link>
  )
}
