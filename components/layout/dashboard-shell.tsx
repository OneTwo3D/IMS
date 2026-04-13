'use client'

import { useState, useEffect } from 'react'
import { usePathname } from 'next/navigation'
import { Sidebar } from './sidebar'
import { Topbar } from './topbar'

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
  const pathname = usePathname()
  const [prevPathname, setPrevPathname] = useState(pathname)

  // Close mobile drawer on route change (render-time state adjustment)
  if (prevPathname !== pathname) {
    setPrevPathname(pathname)
    if (mobileOpen) setMobileOpen(false)
  }

  // Prevent body scroll when drawer is open
  useEffect(() => {
    if (mobileOpen) {
      document.body.style.overflow = 'hidden'
    } else {
      document.body.style.overflow = ''
    }
    return () => {
      document.body.style.overflow = ''
    }
  }, [mobileOpen])

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Desktop sidebar */}
      <div className="hidden md:flex">
        <Sidebar companyName={companyName} logoUrl={logoUrl} userRole={userRole} />
      </div>

      {/* Mobile drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 md:hidden" role="dialog" aria-modal="true">
          <div
            className="absolute inset-0 bg-black/50"
            onClick={() => setMobileOpen(false)}
            aria-label="Close navigation"
          />
          <div className="absolute inset-y-0 left-0 w-56 shadow-xl animate-in slide-in-from-left duration-200">
            <Sidebar
              companyName={companyName}
              logoUrl={logoUrl}
              userRole={userRole}
              onNavigate={() => setMobileOpen(false)}
              forceExpanded
            />
          </div>
        </div>
      )}

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
