'use client'

import { useState, useTransition, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { Camera, Loader2, Check, X, KeyRound, User, Shield } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card } from '@/components/ui/card'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar'
import { useSession } from 'next-auth/react'
import { updateProfile, changePassword, updatePictureUrl } from '@/app/actions/profile'
import { PasskeyManager } from './passkey-manager'

type UserData = {
  id: string
  name: string
  email: string
  role: string
  pictureUrl: string | null
  totpEnabled: boolean
  createdAt: string
}

export function ProfileForm({ user }: { user: UserData }) {
  const router = useRouter()
  const { update: updateSession } = useSession()
  const [isPending, startTransition] = useTransition()
  const fileRef = useRef<HTMLInputElement>(null)

  // Profile fields
  const [name, setName] = useState(user.name)
  const [email, setEmail] = useState(user.email)
  const [profileMsg, setProfileMsg] = useState<{ text: string; isError: boolean } | null>(null)

  // Password
  const [showPasswordDialog, setShowPasswordDialog] = useState(false)
  const [currentPw, setCurrentPw] = useState('')
  const [newPw, setNewPw] = useState('')
  const [confirmPw, setConfirmPw] = useState('')
  const [pwMsg, setPwMsg] = useState<{ text: string; isError: boolean } | null>(null)

  // Picture
  const [pictureUrl, setPictureUrl] = useState(user.pictureUrl)
  const [uploading, setUploading] = useState(false)
  const [uploadMsg, setUploadMsg] = useState<{ text: string; isError: boolean } | null>(null)

  const initials = name
    .split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2)

  function handleSaveProfile() {
    setProfileMsg(null)
    startTransition(async () => {
      const result = await updateProfile({ name, email })
      if (result.success) {
        setProfileMsg({ text: 'Profile updated.', isError: false })
        router.refresh()
      } else {
        setProfileMsg({ text: result.error ?? 'Failed to update profile.', isError: true })
      }
    })
  }

  function handleChangePassword() {
    setPwMsg(null)
    if (newPw !== confirmPw) { setPwMsg({ text: 'Passwords do not match.', isError: true }); return }
    if (newPw.length < 8) { setPwMsg({ text: 'Password must be at least 8 characters.', isError: true }); return }
    startTransition(async () => {
      const result = await changePassword({ currentPassword: currentPw, newPassword: newPw })
      if (result.success) {
        setPwMsg({ text: 'Password changed successfully.', isError: false })
        setCurrentPw(''); setNewPw(''); setConfirmPw('')
        setTimeout(() => setShowPasswordDialog(false), 1500)
      } else {
        setPwMsg({ text: result.error ?? 'Failed to change password.', isError: true })
      }
    })
  }

  async function handlePictureUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    setUploadMsg(null)
    try {
      const formData = new FormData()
      formData.append('file', file)
      const res = await fetch('/api/upload/avatar', { method: 'POST', body: formData })
      const data = await res.json()
      if (res.ok) {
        setPictureUrl(data.pictureUrl)
        await updateSession({ pictureUrl: data.pictureUrl })
        router.refresh()
        setUploadMsg({ text: 'Photo updated.', isError: false })
      } else {
        setUploadMsg({ text: data.error ?? 'Upload failed.', isError: true })
      }
    } catch {
      setUploadMsg({ text: 'Network error during upload.', isError: true })
    } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  async function handleRemovePicture() {
    startTransition(async () => {
      await updatePictureUrl(null)
      setPictureUrl(null)
      await updateSession({ pictureUrl: null })
      router.refresh()
      setUploadMsg(null)
    })
  }

  const ROLE_LABELS: Record<string, string> = {
    ADMIN: 'Administrator', WAREHOUSE: 'Warehouse Manager', FINANCE: 'Finance', READONLY: 'Read Only',
  }

  return (
    <div className="space-y-6">
      {/* Avatar section */}
      <Card className="p-6">
        <div className="flex items-center gap-6">
          <div className="relative group">
            <Avatar className="h-20 w-20" size="lg">
              {pictureUrl && <AvatarImage src={pictureUrl} alt={name} />}
              <AvatarFallback className="text-lg">{initials}</AvatarFallback>
            </Avatar>
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="absolute inset-0 flex items-center justify-center rounded-full bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
              disabled={uploading}
            >
              {uploading ? <Loader2 className="h-5 w-5 text-white animate-spin" /> : <Camera className="h-5 w-5 text-white" />}
            </button>
            <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp,image/gif" className="hidden" onChange={handlePictureUpload} />
          </div>
          <div>
            <h2 className="text-lg font-semibold">{name}</h2>
            <p className="text-sm text-muted-foreground">{email}</p>
            <p className="text-xs text-muted-foreground mt-1">{ROLE_LABELS[user.role] ?? user.role} &middot; Joined {new Date(user.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}</p>
            <div className="flex items-center gap-2 mt-2">
              <Button variant="outline" size="sm" className="text-xs" onClick={() => fileRef.current?.click()} disabled={uploading}>
                {uploading ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Camera className="h-3 w-3 mr-1" />}
                {pictureUrl ? 'Change Photo' : 'Upload Photo'}
              </Button>
              {pictureUrl && (
                <Button variant="ghost" size="sm" className="text-xs text-destructive" onClick={handleRemovePicture} disabled={isPending}>
                  <X className="h-3 w-3 mr-1" />Remove
                </Button>
              )}
            </div>
            {uploadMsg && (
              <p className={`text-xs mt-1 ${uploadMsg.isError ? 'text-destructive' : 'text-green-600'}`}>{uploadMsg.text}</p>
            )}
          </div>
        </div>
      </Card>

      {/* Profile details */}
      <Card className="p-6">
        <div className="flex items-center gap-2 mb-4">
          <User className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-base font-semibold">Profile Details</h2>
        </div>
        <div className="grid grid-cols-2 gap-4 max-w-lg">
          <div className="space-y-1.5">
            <Label>Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} className="h-9" />
          </div>
          <div className="space-y-1.5">
            <Label>Email</Label>
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} className="h-9" />
          </div>
          <div className="space-y-1.5">
            <Label>Role</Label>
            <Input value={ROLE_LABELS[user.role] ?? user.role} disabled className="h-9 bg-muted" />
          </div>
        </div>
        <div className="flex items-center gap-3 mt-4">
          <Button size="sm" onClick={handleSaveProfile} disabled={isPending}>
            {isPending && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
            Save Changes
          </Button>
          {profileMsg && (
            <p className={`text-sm flex items-center gap-1 ${profileMsg.isError ? 'text-destructive' : 'text-green-600'}`}>
              {profileMsg.isError ? <X className="h-3 w-3" /> : <Check className="h-3 w-3" />}
              {profileMsg.text}
            </p>
          )}
        </div>
      </Card>

      {/* Security */}
      <Card className="p-6">
        <div className="flex items-center gap-2 mb-4">
          <Shield className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-base font-semibold">Security</h2>
        </div>
        <div className="space-y-4">
          <div className="flex items-center justify-between py-2 border-b">
            <div>
              <p className="text-sm font-medium">Password</p>
              <p className="text-xs text-muted-foreground">Change your account password</p>
            </div>
            <Button variant="outline" size="sm" onClick={() => { setShowPasswordDialog(true); setPwMsg(null); setCurrentPw(''); setNewPw(''); setConfirmPw('') }}>
              <KeyRound className="h-3 w-3 mr-1" />Change Password
            </Button>
          </div>
          <div className="flex items-center justify-between py-2 border-b">
            <div>
              <p className="text-sm font-medium">Two-Factor Authentication</p>
              <p className="text-xs text-muted-foreground">{user.totpEnabled ? 'Enabled — your account is secured with TOTP' : 'Not enabled — add an extra layer of security'}</p>
            </div>
            <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${user.totpEnabled ? 'bg-green-100 text-green-700' : 'bg-yellow-100 text-yellow-700'}`}>
              {user.totpEnabled ? 'Enabled' : 'Disabled'}
            </span>
          </div>
          <PasskeyManager />
        </div>
      </Card>

      {/* Password change dialog */}
      {showPasswordDialog && (
        <Dialog open onOpenChange={() => {}}>
          <DialogContent showCloseButton={false} className="max-w-sm sm:max-w-sm">
            <DialogHeader>
              <DialogTitle>Change Password</DialogTitle>
            </DialogHeader>
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label>Current Password</Label>
                <Input type="password" value={currentPw} onChange={(e) => setCurrentPw(e.target.value)} className="h-9" autoFocus />
              </div>
              <div className="space-y-1.5">
                <Label>New Password</Label>
                <Input type="password" value={newPw} onChange={(e) => setNewPw(e.target.value)} className="h-9" placeholder="Minimum 8 characters" />
              </div>
              <div className="space-y-1.5">
                <Label>Confirm New Password</Label>
                <Input type="password" value={confirmPw} onChange={(e) => setConfirmPw(e.target.value)} className="h-9" />
              </div>
              {pwMsg && (
                <p className={`text-sm ${pwMsg.isError ? 'text-destructive' : 'text-green-600'}`}>{pwMsg.text}</p>
              )}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setShowPasswordDialog(false)} disabled={isPending}>Cancel</Button>
              <Button onClick={handleChangePassword} disabled={isPending || !currentPw || !newPw}>
                {isPending && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
                Change Password
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}
