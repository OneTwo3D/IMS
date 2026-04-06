'use client'

import { useState, useEffect, useTransition } from 'react'
import { startRegistration } from '@simplewebauthn/browser'
import { Fingerprint, Plus, Trash2, Loader2, Pencil, Check, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  getPasskeyRegistrationOptions,
  verifyPasskeyRegistration,
  listPasskeys,
  deletePasskey,
  renamePasskey,
} from '@/app/actions/passkey'

type PasskeyEntry = { id: string; name: string; createdAt: Date }

export function PasskeyManager() {
  const [passkeys, setPasskeys] = useState<PasskeyEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [isPending, startTransition] = useTransition()
  const [msg, setMsg] = useState<{ text: string; isError: boolean } | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')

  useEffect(() => {
    listPasskeys().then((keys) => { setPasskeys(keys); setLoading(false) })
  }, [])

  async function handleRegister() {
    setMsg(null)
    try {
      const result = await getPasskeyRegistrationOptions()
      if ('error' in result) { setMsg({ text: result.error!, isError: true }); return }

      const credential = await startRegistration({ optionsJSON: result.options! })
      const name = `Passkey ${passkeys.length + 1}`
      const verify = await verifyPasskeyRegistration(credential, name)

      if (verify.error) { setMsg({ text: verify.error, isError: true }); return }

      setMsg({ text: 'Passkey registered successfully.', isError: false })
      const updated = await listPasskeys()
      setPasskeys(updated)
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'Registration cancelled or failed.'
      if (message.includes('ceremony was sent an abort signal') || message.includes('cancelled')) {
        // User cancelled — not an error
        return
      }
      setMsg({ text: message, isError: true })
    }
  }

  function handleDelete(id: string) {
    startTransition(async () => {
      await deletePasskey(id)
      setPasskeys((prev) => prev.filter((p) => p.id !== id))
      setMsg({ text: 'Passkey removed.', isError: false })
    })
  }

  function handleRename(id: string) {
    if (!editName.trim()) return
    startTransition(async () => {
      await renamePasskey(id, editName.trim())
      setPasskeys((prev) => prev.map((p) => p.id === id ? { ...p, name: editName.trim() } : p))
      setEditingId(null)
    })
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium">Passkeys</p>
          <p className="text-xs text-muted-foreground">Sign in without a password using biometrics or security keys</p>
        </div>
        <Button variant="outline" size="sm" onClick={handleRegister} disabled={isPending}>
          <Plus className="h-3 w-3 mr-1" />Add Passkey
        </Button>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
          <Loader2 className="h-3 w-3 animate-spin" />Loading...
        </div>
      ) : passkeys.length === 0 ? (
        <p className="text-xs text-muted-foreground py-2">No passkeys registered yet.</p>
      ) : (
        <div className="space-y-1">
          {passkeys.map((pk) => (
            <div key={pk.id} className="flex items-center justify-between py-2 px-2 rounded-md hover:bg-muted/50">
              <div className="flex items-center gap-2">
                <Fingerprint className="h-4 w-4 text-muted-foreground" />
                {editingId === pk.id ? (
                  <div className="flex items-center gap-1">
                    <Input
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      className="h-7 w-40 text-xs"
                      onKeyDown={(e) => e.key === 'Enter' && handleRename(pk.id)}
                      autoFocus
                    />
                    <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => handleRename(pk.id)} disabled={isPending}>
                      <Check className="h-3 w-3" />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => setEditingId(null)}>
                      <X className="h-3 w-3" />
                    </Button>
                  </div>
                ) : (
                  <div>
                    <p className="text-sm">{pk.name}</p>
                    <p className="text-xs text-muted-foreground">
                      Added {new Date(pk.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                    </p>
                  </div>
                )}
              </div>
              {editingId !== pk.id && (
                <div className="flex items-center gap-1">
                  <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => { setEditingId(pk.id); setEditName(pk.name) }}>
                    <Pencil className="h-3 w-3" />
                  </Button>
                  <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={() => handleDelete(pk.id)} disabled={isPending}>
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {msg && (
        <p className={`text-xs ${msg.isError ? 'text-destructive' : 'text-green-600'}`}>{msg.text}</p>
      )}
    </div>
  )
}
