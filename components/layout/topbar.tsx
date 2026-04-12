'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { Moon, Sun, LogOut, User, Settings, Bell, CheckCircle2, AlertTriangle, Info, XCircle, Menu } from 'lucide-react'
import { useTheme } from 'next-themes'
import { signOut, useSession } from 'next-auth/react'
import { Button } from '@/components/ui/button'
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar'

interface TopbarProps {
  userName: string
  userEmail: string
  userPictureUrl?: string | null
  onMenuClick?: () => void
}

type Notification = {
  id: string
  type: string
  title: string
  message: string
  actionUrl: string | null
  read: boolean
  createdAt: string
}

const TYPE_ICON: Record<string, typeof Info> = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  error: XCircle,
}
const TYPE_COLOR: Record<string, string> = {
  info: 'text-blue-500',
  success: 'text-green-500',
  warning: 'text-orange-500',
  error: 'text-destructive',
}

function timeAgo(dateStr: string) {
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  return `${days}d ago`
}

export function Topbar({ userName, userEmail, userPictureUrl, onMenuClick }: TopbarProps) {
  const { setTheme, resolvedTheme } = useTheme()
  const router = useRouter()
  const { data: session } = useSession()
  const [open, setOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  // Notification state
  const [bellOpen, setBellOpen] = useState(false)
  const bellRef = useRef<HTMLDivElement>(null)
  const [notifications, setNotifications] = useState<Notification[]>([])
  const [unreadCount, setUnreadCount] = useState(0)

  // Prefer client-side session pictureUrl (updates instantly after upload)
  const pictureUrl = (session?.user as { pictureUrl?: string | null } | undefined)?.pictureUrl ?? userPictureUrl

  const initials = userName
    .split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2)

  // Outside-click for user menu
  useEffect(() => {
    if (!open) return
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open])

  // Outside-click for bell dropdown
  useEffect(() => {
    if (!bellOpen) return
    function handleClick(e: MouseEvent) {
      if (bellRef.current && !bellRef.current.contains(e.target as Node)) setBellOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [bellOpen])

  // Fetch notifications
  const fetchNotifications = useCallback(async () => {
    try {
      const res = await fetch('/api/notifications')
      if (!res.ok) return
      const data = await res.json()
      setNotifications(data.notifications)
      setUnreadCount(data.unreadCount)
    } catch { /* ignore */ }
  }, [])

  // Poll every 30 seconds
  useEffect(() => {
    fetchNotifications()
    const interval = setInterval(fetchNotifications, 30000)
    return () => clearInterval(interval)
  }, [fetchNotifications])

  async function markAllRead() {
    try {
      await fetch('/api/notifications', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ all: true }),
      })
      setNotifications((prev) => prev.map((n) => ({ ...n, read: true })))
      setUnreadCount(0)
    } catch { /* ignore */ }
  }

  async function handleNotificationClick(n: Notification) {
    if (!n.read) {
      try {
        await fetch('/api/notifications', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: [n.id] }),
        })
        setNotifications((prev) => prev.map((x) => x.id === n.id ? { ...x, read: true } : x))
        setUnreadCount((c) => Math.max(0, c - 1))
      } catch { /* ignore */ }
    }
    if (n.actionUrl) {
      setBellOpen(false)
      router.push(n.actionUrl)
    }
  }

  return (
    <header className="flex h-14 items-center border-b bg-card px-2 sm:px-4 gap-1">
      {onMenuClick && (
        <Button
          variant="ghost"
          size="icon"
          className="md:hidden"
          onClick={onMenuClick}
          aria-label="Open navigation"
        >
          <Menu className="h-5 w-5" />
        </Button>
      )}
      <div className="flex-1" />
      <span className="text-sm font-semibold text-muted-foreground tracking-wide truncate">One Two Inventory</span>
      <div className="flex-1 flex items-center justify-end gap-2" />

      {/* Notification bell */}
      <div className="relative" ref={bellRef}>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setBellOpen((v) => !v)}
          aria-label="Notifications"
          className="relative"
        >
          <Bell className="h-4 w-4" />
          {unreadCount > 0 && (
            <span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-bold text-destructive-foreground">
              {unreadCount > 99 ? '99+' : unreadCount}
            </span>
          )}
        </Button>

        {bellOpen && (
          <div className="absolute right-0 top-full mt-1 z-50 w-[calc(100vw-2rem)] sm:w-80 rounded-lg border bg-popover text-popover-foreground shadow-lg">
            <div className="flex items-center justify-between px-3 py-2 border-b">
              <span className="text-sm font-medium">Notifications</span>
              {unreadCount > 0 && (
                <button
                  type="button"
                  className="text-xs text-primary hover:underline"
                  onClick={markAllRead}
                >
                  Mark all as read
                </button>
              )}
            </div>
            <div className="max-h-80 overflow-y-auto">
              {notifications.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-6">No notifications</p>
              ) : (
                notifications.map((n) => {
                  const Icon = TYPE_ICON[n.type] || Info
                  const color = TYPE_COLOR[n.type] || 'text-muted-foreground'
                  return (
                    <button
                      key={n.id}
                      type="button"
                      className={`flex w-full gap-2.5 px-3 py-2.5 text-left hover:bg-accent transition-colors ${!n.read ? 'bg-accent/40' : ''} ${n.actionUrl ? 'cursor-pointer' : 'cursor-default'}`}
                      onClick={() => handleNotificationClick(n)}
                    >
                      <Icon className={`h-4 w-4 mt-0.5 shrink-0 ${color}`} />
                      <div className="min-w-0 flex-1">
                        <p className={`text-sm leading-tight ${!n.read ? 'font-medium' : ''}`}>{n.title}</p>
                        <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{n.message}</p>
                        <p className="text-[10px] text-muted-foreground mt-1">{timeAgo(n.createdAt)}</p>
                      </div>
                      {!n.read && <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-primary" />}
                    </button>
                  )
                })
              )}
            </div>
          </div>
        )}
      </div>

      <Button
        variant="ghost"
        size="icon"
        onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
        aria-label="Toggle theme"
      >
        <Sun className="h-4 w-4 rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
        <Moon className="absolute h-4 w-4 rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
      </Button>

      <div className="relative" ref={menuRef}>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label="User menu"
          aria-expanded={open}
        >
          <Avatar className="h-8 w-8">
            {pictureUrl && <AvatarImage src={pictureUrl} alt={userName} />}
            <AvatarFallback className="text-xs">{initials}</AvatarFallback>
          </Avatar>
        </button>

        {open && (
          <div role="menu" className="absolute right-0 top-full mt-1 z-50 w-[calc(100vw-2rem)] sm:w-52 rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg">
            <div className="px-2 py-1.5">
              <p className="text-sm font-medium leading-none">{userName}</p>
              <p className="text-xs leading-none text-muted-foreground mt-1">{userEmail}</p>
            </div>
            <div className="h-px bg-border my-1" />
            <button
              type="button"
              className="flex w-full items-center rounded-md px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground transition-colors"
              onClick={() => { setOpen(false); router.push('/profile') }}
            >
              <User className="mr-2 h-4 w-4" />
              Profile &amp; 2FA
            </button>
            <button
              type="button"
              className="flex w-full items-center rounded-md px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground transition-colors"
              onClick={() => { setOpen(false); router.push('/settings') }}
            >
              <Settings className="mr-2 h-4 w-4" />
              Settings
            </button>
            <div className="h-px bg-border my-1" />
            <button
              type="button"
              className="flex w-full items-center rounded-md px-2 py-1.5 text-sm text-destructive hover:bg-destructive/10 transition-colors"
              onClick={() => signOut({ callbackUrl: '/login' })}
            >
              <LogOut className="mr-2 h-4 w-4" />
              Sign out
            </button>
          </div>
        )}
      </div>
    </header>
  )
}
