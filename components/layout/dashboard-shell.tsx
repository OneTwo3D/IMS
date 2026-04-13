'use client'

import { useState } from 'react'
import { Sidebar } from './sidebar'
import { Topbar } from './topbar'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'

interface DashboardShellProps {
  companyName?: string
  logoUrl?: string | null
  userRole?: string
  userName: string
  userEmail: string
  userPictureUrl?: string | null
  children: React.ReactNode
}

export function DashboardShell({
  companyName,
  logoUrl,
  userRole,
  userName,
  userEmail,
  userPictureUrl,
  children,
}: DashboardShellProps) {
  const [mobileOpen, setMobileOpen] = useState(false)

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Desktop sidebar */}
      <div className="hidden md:flex">
        <Sidebar companyName={companyName} logoUrl={logoUrl} userRole={userRole} />
      </div>

      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent side="left" className="w-72 max-w-[85vw] p-0 md:hidden">
          <SheetHeader className="sr-only">
            <SheetTitle>Navigation</SheetTitle>
          </SheetHeader>
          <div className="h-full">
            <Sidebar
              companyName={companyName}
              logoUrl={logoUrl}
              userRole={userRole}
              onNavigate={() => setMobileOpen(false)}
              forceExpanded
            />
          </div>
        </SheetContent>
      </Sheet>

      <div className="flex flex-1 flex-col overflow-hidden min-w-0">
        <Topbar
          userName={userName}
          userEmail={userEmail}
          userPictureUrl={userPictureUrl}
          onMenuClick={() => setMobileOpen(true)}
        />
        <main className="flex-1 overflow-auto p-3 sm:p-4 md:p-6">{children}</main>
      </div>
    </div>
  )
}
