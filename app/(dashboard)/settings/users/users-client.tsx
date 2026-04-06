'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, Plus, Pencil, Shield, ShieldCheck, User, Factory, Eye, BarChart3, Warehouse } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { createUser, updateUser, type UserRow } from '@/app/actions/users'

type SupplierOption = { id: string; name: string }
type Props = { users: UserRow[]; suppliers: SupplierOption[] }

const ROLES = [
  { value: 'ADMIN', label: 'Admin', description: 'Full access to all features and settings', icon: ShieldCheck, color: 'text-red-600' },
  { value: 'MANAGER', label: 'Manager', description: 'Full access except settings and user management', icon: Shield, color: 'text-blue-600' },
  { value: 'WAREHOUSE', label: 'Warehouse', description: 'Stock control, picking, receiving, manufacturing', icon: Warehouse, color: 'text-green-600' },
  { value: 'FINANCE', label: 'Finance', description: 'Purchasing, invoicing, analytics, refunds', icon: BarChart3, color: 'text-purple-600' },
  { value: 'READONLY', label: 'Read Only', description: 'View dashboard, inventory, orders, analytics', icon: Eye, color: 'text-gray-600' },
  { value: 'SUPPLIER', label: 'Supplier', description: 'View own RFQs, POs, and products only', icon: Factory, color: 'text-orange-600' },
]

const ROLE_BADGE: Record<string, string> = {
  ADMIN: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200',
  MANAGER: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
  WAREHOUSE: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
  FINANCE: 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200',
  READONLY: 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200',
  SUPPLIER: 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200',
}

export function UsersClient({ users, suppliers }: Props) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [showCreate, setShowCreate] = useState(false)
  const [editUser, setEditUser] = useState<UserRow | null>(null)

  // Create form
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState('WAREHOUSE')
  const [supplierId, setSupplierId] = useState('')
  const [error, setError] = useState('')

  // Edit form
  const [editName, setEditName] = useState('')
  const [editEmail, setEditEmail] = useState('')
  const [editRole, setEditRole] = useState('')
  const [editSupplierId, setEditSupplierId] = useState('')
  const [editPassword, setEditPassword] = useState('')
  const [editActive, setEditActive] = useState(true)
  const [editError, setEditError] = useState('')

  function openCreate() {
    setName(''); setEmail(''); setPassword(''); setRole('WAREHOUSE'); setSupplierId(''); setError('')
    setShowCreate(true)
  }

  function openEdit(u: UserRow) {
    setEditName(u.name); setEditEmail(u.email); setEditRole(u.role)
    setEditSupplierId(u.supplierId ?? ''); setEditPassword(''); setEditActive(u.active); setEditError('')
    setEditUser(u)
  }

  function handleCreate() {
    setError('')
    startTransition(async () => {
      const result = await createUser({ name, email, password, role, supplierId: role === 'SUPPLIER' ? supplierId : undefined })
      if (result.success) { setShowCreate(false); router.refresh() }
      else setError(result.error ?? 'Failed')
    })
  }

  function handleUpdate() {
    if (!editUser) return
    setEditError('')
    startTransition(async () => {
      const result = await updateUser(editUser.id, {
        name: editName, email: editEmail, role: editRole,
        supplierId: editRole === 'SUPPLIER' ? editSupplierId : null,
        active: editActive,
        password: editPassword || undefined,
      })
      if (result.success) { setEditUser(null); router.refresh() }
      else setEditError(result.error ?? 'Failed')
    })
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <span className="text-sm text-muted-foreground">{users.length} user(s)</span>
        <Button size="sm" onClick={openCreate}><Plus className="h-4 w-4 mr-1" />Add User</Button>
      </div>

      {/* Users table */}
      <div className="rounded-md border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 border-b"><tr>
            <th className="px-4 py-2 text-left text-xs font-medium text-muted-foreground">Name</th>
            <th className="px-4 py-2 text-left text-xs font-medium text-muted-foreground">Email</th>
            <th className="px-4 py-2 text-left text-xs font-medium text-muted-foreground">Role</th>
            <th className="px-4 py-2 text-left text-xs font-medium text-muted-foreground">Supplier</th>
            <th className="px-4 py-2 text-left text-xs font-medium text-muted-foreground">Status</th>
            <th className="px-4 py-2 text-left text-xs font-medium text-muted-foreground">2FA</th>
            <th className="px-4 py-2 text-left text-xs font-medium text-muted-foreground">Last Login</th>
            <th className="px-4 py-2 w-10" />
          </tr></thead>
          <tbody className="divide-y">
            {users.map((u) => (
              <tr key={u.id} className={!u.active ? 'opacity-50' : ''}>
                <td className="px-4 py-2 font-medium">{u.name}</td>
                <td className="px-4 py-2 text-muted-foreground">{u.email}</td>
                <td className="px-4 py-2">
                  <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${ROLE_BADGE[u.role] ?? ''}`}>
                    {u.role}
                  </span>
                </td>
                <td className="px-4 py-2 text-xs text-muted-foreground">{u.supplierName ?? '—'}</td>
                <td className="px-4 py-2">
                  {u.active
                    ? <span className="text-xs text-green-600 font-medium">Active</span>
                    : <span className="text-xs text-muted-foreground">Inactive</span>
                  }
                </td>
                <td className="px-4 py-2 text-xs">{u.totpEnabled ? '✓' : '—'}</td>
                <td className="px-4 py-2 text-xs text-muted-foreground">
                  {u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : 'Never'}
                </td>
                <td className="px-4 py-2">
                  <button type="button" onClick={() => openEdit(u)} className="text-muted-foreground hover:text-foreground">
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Role descriptions */}
      <div className="rounded-md border p-4 space-y-2">
        <h3 className="text-sm font-semibold text-muted-foreground">Role Permissions</h3>
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
          {ROLES.map((r) => (
            <div key={r.value} className="flex items-start gap-2">
              <r.icon className={`h-4 w-4 mt-0.5 shrink-0 ${r.color}`} />
              <div>
                <span className="text-sm font-medium">{r.label}</span>
                <p className="text-xs text-muted-foreground">{r.description}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Create dialog */}
      {showCreate && (
        <Dialog open onOpenChange={() => {}}><DialogContent showCloseButton={false} className="max-w-md sm:max-w-md">
          <DialogHeader><DialogTitle>Add User</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5"><Label>Name *</Label><Input value={name} onChange={(e) => setName(e.target.value)} className="h-9 text-sm" /></div>
            <div className="space-y-1.5"><Label>Email *</Label><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} className="h-9 text-sm" /></div>
            <div className="space-y-1.5"><Label>Password *</Label><Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Min 8 characters" className="h-9 text-sm" /></div>
            <div className="space-y-1.5">
              <Label>Role *</Label>
              <select value={role} onChange={(e) => setRole(e.target.value)} className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm">
                {ROLES.map((r) => (<option key={r.value} value={r.value}>{r.label} — {r.description}</option>))}
              </select>
            </div>
            {role === 'SUPPLIER' && (
              <div className="space-y-1.5">
                <Label>Linked Supplier *</Label>
                <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)} className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm">
                  <option value="">Select supplier…</option>
                  {suppliers.map((s) => (<option key={s.id} value={s.id}>{s.name}</option>))}
                </select>
              </div>
            )}
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreate(false)} disabled={isPending}>Cancel</Button>
            <Button onClick={handleCreate} disabled={isPending}>{isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}Create User</Button>
          </DialogFooter>
        </DialogContent></Dialog>
      )}

      {/* Edit dialog */}
      {editUser && (
        <Dialog open onOpenChange={() => {}}><DialogContent showCloseButton={false} className="max-w-md sm:max-w-md">
          <DialogHeader><DialogTitle>Edit User</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5"><Label>Name</Label><Input value={editName} onChange={(e) => setEditName(e.target.value)} className="h-9 text-sm" /></div>
            <div className="space-y-1.5"><Label>Email</Label><Input type="email" value={editEmail} onChange={(e) => setEditEmail(e.target.value)} className="h-9 text-sm" /></div>
            <div className="space-y-1.5"><Label>New Password</Label><Input type="password" value={editPassword} onChange={(e) => setEditPassword(e.target.value)} placeholder="Leave blank to keep current" className="h-9 text-sm" /></div>
            <div className="space-y-1.5">
              <Label>Role</Label>
              <select value={editRole} onChange={(e) => setEditRole(e.target.value)} className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm">
                {ROLES.map((r) => (<option key={r.value} value={r.value}>{r.label}</option>))}
              </select>
            </div>
            {editRole === 'SUPPLIER' && (
              <div className="space-y-1.5">
                <Label>Linked Supplier</Label>
                <select value={editSupplierId} onChange={(e) => setEditSupplierId(e.target.value)} className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm">
                  <option value="">Select supplier…</option>
                  {suppliers.map((s) => (<option key={s.id} value={s.id}>{s.name}</option>))}
                </select>
              </div>
            )}
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={editActive} onChange={(e) => setEditActive(e.target.checked)} className="rounded border-input" />
              <span className="text-sm">Active</span>
            </label>
            {editError && <p className="text-sm text-destructive">{editError}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditUser(null)} disabled={isPending}>Cancel</Button>
            <Button onClick={handleUpdate} disabled={isPending}>{isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}Save Changes</Button>
          </DialogFooter>
        </DialogContent></Dialog>
      )}
    </div>
  )
}
