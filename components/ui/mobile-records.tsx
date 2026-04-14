import { cn } from '@/lib/utils'

export function ResponsiveTableLayout({
  mobile,
  desktop,
}: {
  mobile: React.ReactNode
  desktop: React.ReactNode
}) {
  return (
    <>
      <div className="md:hidden">{mobile}</div>
      <div className="hidden md:block">{desktop}</div>
    </>
  )
}

export function MobileRecordList({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return <div className={cn('space-y-3', className)}>{children}</div>
}

export function MobileRecordCard({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn('rounded-lg border border-border bg-card p-3 shadow-sm', className)}>
      {children}
    </div>
  )
}

export function MobileRecordField({
  label,
  value,
  className,
}: {
  label: string
  value: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn('rounded-md bg-muted/50 px-2.5 py-2', className)}>
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <div className="mt-1 text-sm font-medium">{value}</div>
    </div>
  )
}
