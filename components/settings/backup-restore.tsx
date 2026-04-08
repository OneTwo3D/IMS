'use client'

import { useState, useEffect, useTransition, useRef } from 'react'
import { useRouter } from 'next/navigation'
import {
  Download, Upload, Trash2, Loader2, Check, X, AlertTriangle,
  HardDrive, Cloud, Server, RefreshCw,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { listBackups, deleteBackup, type BackupEntry } from '@/app/actions/backup'

function fmtSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export function BackupRestore() {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [backups, setBackups] = useState<BackupEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [msg, setMsg] = useState<{ text: string; isError: boolean } | null>(null)
  const [creating, setCreating] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const [uploading, setUploading] = useState<string | null>(null)
  const [showRestore, setShowRestore] = useState<{ filename: string } | null>(null)
  const [showUploadRestore, setShowUploadRestore] = useState(false)
  const [restoreConfirm, setRestoreConfirm] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  const refreshList = () => listBackups().then(setBackups)

  useEffect(() => { refreshList().then(() => setLoading(false)).catch(() => setLoading(false)) }, [])

  async function handleCreate() {
    setMsg(null)
    setCreating(true)
    try {
      const res = await fetch('/api/backup/create', { method: 'POST' })
      if (res.ok) {
        // Download the file
        const blob = await res.blob()
        const filename = res.headers.get('content-disposition')?.match(/filename="(.+)"/)?.[1] ?? 'backup.sql'
        const a = document.createElement('a')
        a.href = URL.createObjectURL(blob)
        a.download = filename
        a.click()
        URL.revokeObjectURL(a.href)
        setMsg({ text: 'Backup created and downloaded.', isError: false })
        await refreshList()
      } else {
        const data = await res.json()
        setMsg({ text: data.error ?? 'Backup failed.', isError: true })
      }
    } catch {
      setMsg({ text: 'Backup failed.', isError: true })
    } finally {
      setCreating(false)
    }
  }

  async function handleRestore(filename: string) {
    if (restoreConfirm !== 'RESTORE') return
    setRestoring(true)
    setMsg(null)
    try {
      const formData = new FormData()
      formData.append('filename', filename)
      const res = await fetch('/api/backup/restore', { method: 'POST', body: formData })
      const data = await res.json()
      if (res.ok) {
        setMsg({ text: 'Database restored successfully. Please refresh.', isError: false })
        setShowRestore(null)
        setRestoreConfirm('')
        router.refresh()
      } else {
        setMsg({ text: data.error ?? 'Restore failed.', isError: true })
      }
    } catch {
      setMsg({ text: 'Restore failed.', isError: true })
    } finally {
      setRestoring(false)
    }
  }

  async function handleUploadRestore(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    if (restoreConfirm !== 'RESTORE') return
    setRestoring(true)
    setMsg(null)
    try {
      const formData = new FormData()
      formData.append('file', file)
      const res = await fetch('/api/backup/restore', { method: 'POST', body: formData })
      const data = await res.json()
      if (res.ok) {
        setMsg({ text: 'Database restored from uploaded file. Please refresh.', isError: false })
        setShowUploadRestore(false)
        setRestoreConfirm('')
        router.refresh()
      } else {
        setMsg({ text: data.error ?? 'Restore failed.', isError: true })
      }
    } catch {
      setMsg({ text: 'Restore failed.', isError: true })
    } finally {
      setRestoring(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  async function handleDelete(filename: string) {
    startTransition(async () => {
      await deleteBackup(filename)
      await refreshList()
    })
  }

  async function handleRemoteUpload(filename: string, target: 's3' | 'sftp') {
    setUploading(`${filename}-${target}`)
    setMsg(null)
    try {
      const res = await fetch('/api/backup/upload-remote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename, target }),
      })
      const data = await res.json()
      if (res.ok) {
        setMsg({ text: `Uploaded to ${data.destination}`, isError: false })
      } else {
        setMsg({ text: data.error ?? 'Upload failed.', isError: true })
      }
    } catch {
      setMsg({ text: 'Upload failed.', isError: true })
    } finally {
      setUploading(null)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={handleCreate} disabled={creating}>
          {creating ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Download className="h-4 w-4 mr-1" />}
          Create Backup
        </Button>
        <Button variant="outline" size="sm" onClick={() => { setShowUploadRestore(true); setRestoreConfirm('') }}>
          <Upload className="h-4 w-4 mr-1" />
          Restore from File
        </Button>
      </div>

      {msg && (
        <p className={`text-sm flex items-center gap-1 ${msg.isError ? 'text-destructive' : 'text-green-600'}`}>
          {msg.isError ? <X className="h-3 w-3" /> : <Check className="h-3 w-3" />}
          {msg.text}
        </p>
      )}

      {/* Backup list */}
      {loading ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
          <Loader2 className="h-3 w-3 animate-spin" />Loading backups...
        </div>
      ) : backups.length === 0 ? (
        <p className="text-sm text-muted-foreground">No backups yet. Create your first backup above.</p>
      ) : (
        <div className="space-y-1">
          {backups.map((b) => (
            <div key={b.filename} className="flex items-center justify-between py-2 px-2 rounded-md hover:bg-muted/50">
              <div className="flex items-center gap-2">
                <HardDrive className="h-4 w-4 text-muted-foreground" />
                <div>
                  <p className="text-sm font-mono">{b.filename}</p>
                  <p className="text-xs text-muted-foreground">{fmtSize(b.size)} &middot; {fmtDate(b.createdAt)}</p>
                </div>
              </div>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => handleRemoteUpload(b.filename, 's3')}
                  disabled={uploading === `${b.filename}-s3`}
                  title="Upload to S3"
                >
                  {uploading === `${b.filename}-s3` ? <Loader2 className="h-3 w-3 animate-spin" /> : <Cloud className="h-3 w-3" />}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => handleRemoteUpload(b.filename, 'sftp')}
                  disabled={uploading === `${b.filename}-sftp`}
                  title="Upload via SFTP"
                >
                  {uploading === `${b.filename}-sftp` ? <Loader2 className="h-3 w-3 animate-spin" /> : <Server className="h-3 w-3" />}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => { setShowRestore({ filename: b.filename }); setRestoreConfirm('') }}
                  title="Restore this backup"
                >
                  <RefreshCw className="h-3 w-3" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs text-destructive"
                  onClick={() => handleDelete(b.filename)}
                  disabled={isPending}
                  title="Delete backup"
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Restore from existing backup dialog */}
      {showRestore && (
        <Dialog open onOpenChange={() => {}}>
          <DialogContent showCloseButton={false} className="max-w-md sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-destructive">
                <AlertTriangle className="h-5 w-5" />
                Restore Database
              </DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div className="rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm">
                <p className="font-medium text-destructive">This will overwrite the current database.</p>
                <p className="text-muted-foreground mt-1">Restoring from: <code className="text-xs bg-muted px-1 rounded">{showRestore.filename}</code></p>
              </div>
              <div className="space-y-1.5">
                <Label>Type <code className="text-xs bg-muted px-1 rounded font-bold">RESTORE</code> to confirm</Label>
                <Input
                  value={restoreConfirm}
                  onChange={(e) => setRestoreConfirm(e.target.value)}
                  placeholder="RESTORE"
                  className="h-9 font-mono text-sm"
                  autoFocus
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setShowRestore(null)} disabled={restoring}>Cancel</Button>
              <Button variant="destructive" onClick={() => handleRestore(showRestore.filename)} disabled={restoring || restoreConfirm !== 'RESTORE'}>
                {restoring && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
                Confirm Restore
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {/* Restore from uploaded file dialog */}
      {showUploadRestore && (
        <Dialog open onOpenChange={() => {}}>
          <DialogContent showCloseButton={false} className="max-w-md sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-destructive">
                <AlertTriangle className="h-5 w-5" />
                Restore from File
              </DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div className="rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm">
                <p className="font-medium text-destructive">This will overwrite the current database.</p>
                <p className="text-muted-foreground mt-1">Upload a .sql backup file to restore.</p>
              </div>
              <div className="space-y-1.5">
                <Label>Type <code className="text-xs bg-muted px-1 rounded font-bold">RESTORE</code> to confirm</Label>
                <Input
                  value={restoreConfirm}
                  onChange={(e) => setRestoreConfirm(e.target.value)}
                  placeholder="RESTORE"
                  className="h-9 font-mono text-sm"
                  autoFocus
                />
              </div>
              {restoreConfirm === 'RESTORE' && (
                <div className="space-y-1.5">
                  <Label>Select backup file</Label>
                  <Input
                    ref={fileRef}
                    type="file"
                    accept=".sql,.dump"
                    onChange={handleUploadRestore}
                    disabled={restoring}
                    className="h-9"
                  />
                </div>
              )}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setShowUploadRestore(false)} disabled={restoring}>Cancel</Button>
              {restoring && <Loader2 className="h-4 w-4 animate-spin" />}
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}
