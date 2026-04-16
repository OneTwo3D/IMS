'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Moon, Sun, LogOut, User, Settings, Bell, CheckCircle2, AlertTriangle, Info, XCircle, Menu } from 'lucide-react'
import { signOut, useSession } from 'next-auth/react'
import { Button } from '@/components/ui/button'
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useTheme } from '@/components/providers/theme-provider'

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
  const [notifications, setNotifications] = useState<Notification[]>([])
  const [unreadCount, setUnreadCount] = useState(0)
  const [selectedNotification, setSelectedNotification] = useState<Notification | null>(null)

  // Prefer client-side session pictureUrl (updates instantly after upload)
  const pictureUrl = (session?.user as { pictureUrl?: string | null } | undefined)?.pictureUrl ?? userPictureUrl

  const initials = userName
    .split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2)

  async function loadNotifications() {
    const res = await fetch('/api/notifications', { cache: 'no-store' })
    if (!res.ok) throw new Error('Failed to load notifications')
    const data = await res.json()
    setNotifications(data.notifications)
    setUnreadCount(data.unreadCount)
  }

  // Poll notifications every 30 seconds
  useEffect(() => {
    let cancelled = false
    async function poll() {
      try {
        const res = await fetch('/api/notifications', { cache: 'no-store' })
        if (!res.ok || cancelled) return
        const data = await res.json()
        if (cancelled) return
        setNotifications(data.notifications)
        setUnreadCount(data.unreadCount)
      } catch { /* ignore */ }
    }
    poll()
    const interval = setInterval(poll, 30000)
    return () => { cancelled = true; clearInterval(interval) }
  }, [])

  async function markAllRead() {
    try {
      const res = await fetch('/api/notifications', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ all: true }),
        cache: 'no-store',
      })
      if (!res.ok) return
      await loadNotifications()
    } catch { /* ignore */ }
  }

  async function handleNotificationClick(n: Notification) {
    if (!n.read) {
      try {
        const res = await fetch('/api/notifications', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: [n.id] }),
          cache: 'no-store',
        })
        if (!res.ok) return
        await loadNotifications()
        setSelectedNotification({ ...n, read: true })
        return
      } catch { /* ignore */ }
    }
    setSelectedNotification(n)
  }

  function openNotificationAction() {
    if (!selectedNotification?.actionUrl) return
    const actionUrl = selectedNotification.actionUrl
    setSelectedNotification(null)
    router.push(actionUrl)
  }

  function handleSignOut() {
    const callbackUrl = typeof window === 'undefined' ? '/login' : `${window.location.origin}/login`
    void signOut({ callbackUrl })
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
      <span className="hidden truncate text-sm font-semibold tracking-wide text-muted-foreground min-[420px]:block">
        One Two Inventory
      </span>
      <div className="flex flex-1 items-center justify-end gap-2" />

      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button variant="ghost" size="icon" aria-label="Notifications" className="relative" />
          }
        >
          <Bell className="h-4 w-4" />
          {unreadCount > 0 && (
            <span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-bold text-destructive-foreground">
              {unreadCount > 99 ? '99+' : unreadCount}
            </span>
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-[calc(100vw-2rem)] min-w-0 sm:w-80 p-0">
          <div className="rounded-lg border bg-popover text-popover-foreground shadow-lg">
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
                    <DropdownMenuItem
                      key={n.id}
                      className={`flex items-start gap-2.5 px-3 py-2.5 ${!n.read ? 'bg-accent/40' : ''}`}
                      onClick={() => handleNotificationClick(n)}
                    >
                      <Icon className={`h-4 w-4 mt-0.5 shrink-0 ${color}`} />
                      <div className="min-w-0 flex-1">
                        <p className={`text-sm leading-tight ${!n.read ? 'font-medium' : ''}`}>{n.title}</p>
                        <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{n.message}</p>
                        <p className="text-[10px] text-muted-foreground mt-1">{timeAgo(n.createdAt)}</p>
                      </div>
                      {!n.read && <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-primary" />}
                    </DropdownMenuItem>
                  )
                })
              )}
            </div>
          </div>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={selectedNotification !== null} onOpenChange={(open) => { if (!open) setSelectedNotification(null) }}>
        <DialogContent className="max-w-lg sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{selectedNotification?.title ?? 'Notification'}</DialogTitle>
            <DialogDescription className="text-xs">
              {selectedNotification ? new Date(selectedNotification.createdAt).toLocaleString() : ''}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <p className="whitespace-pre-wrap text-sm leading-6 text-foreground">
              {selectedNotification?.message}
            </p>
          </div>
          <DialogFooter showCloseButton>
            {selectedNotification?.actionUrl && (
              <Button onClick={openNotificationAction}>
                Open related page
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Button
        variant="ghost"
        size="icon"
        onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
        aria-label="Toggle theme"
      >
        <Sun className="h-4 w-4 rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
        <Moon className="absolute h-4 w-4 rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
      </Button>

      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label="User menu"
            />
          }
        >
          <Avatar className="h-8 w-8">
            {pictureUrl && <AvatarImage src={pictureUrl} alt={userName} />}
            <AvatarFallback className="text-xs">{initials}</AvatarFallback>
          </Avatar>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-[calc(100vw-2rem)] min-w-0 sm:w-52 p-1">
            <div className="px-2 py-1.5">
              <p className="text-sm font-medium leading-none">{userName}</p>
              <p className="text-xs leading-none text-muted-foreground mt-1">{userEmail}</p>
            </div>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => router.push('/profile')}>
              <User className="mr-2 h-4 w-4" />
              Profile &amp; 2FA
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => router.push('/settings')}>
              <Settings className="mr-2 h-4 w-4" />
              Settings
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={handleSignOut}>
              <LogOut className="mr-2 h-4 w-4" />
              Sign out
            </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  )
}
