'use client'

import { useState, useRef, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Moon, Sun, LogOut, User, Settings } from 'lucide-react'
import { useTheme } from 'next-themes'
import { signOut, useSession } from 'next-auth/react'
import { Button } from '@/components/ui/button'
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar'

interface TopbarProps {
  userName: string
  userEmail: string
  userPictureUrl?: string | null
}

export function Topbar({ userName, userEmail, userPictureUrl }: TopbarProps) {
  const { setTheme, resolvedTheme } = useTheme()
  const router = useRouter()
  const { data: session } = useSession()
  const [open, setOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  // Prefer client-side session pictureUrl (updates instantly after upload)
  const pictureUrl = (session?.user as { pictureUrl?: string | null } | undefined)?.pictureUrl ?? userPictureUrl

  const initials = userName
    .split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2)

  useEffect(() => {
    if (!open) return
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open])

  return (
    <header className="flex h-14 items-center border-b bg-card px-4">
      <div className="flex-1" />
      <span className="text-sm font-semibold text-muted-foreground tracking-wide">One Two Inventory</span>
      <div className="flex-1 flex items-center justify-end gap-2" />
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
        >
          <Avatar className="h-8 w-8">
            {pictureUrl && <AvatarImage src={pictureUrl} alt={userName} />}
            <AvatarFallback className="text-xs">{initials}</AvatarFallback>
          </Avatar>
        </button>

        {open && (
          <div className="absolute right-0 top-full mt-1 z-50 w-52 rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg">
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
