'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, Plus, Pencil, Shield, ShieldCheck, Factory, Eye, BarChart3, Warehouse, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { createUser, deleteUser, updateUser, type UserRow } from '@/app/actions/users'

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
  const [isCreatePending, startCreateTransition] = useTransition()
  const [isUpdatePending, startUpdateTransition] = useTransition()
  const [isDeletePending, startDeleteTransition] = useTransition()
  const [showCreate, setShowCreate] = useState(false)
  const [editUser, setEditUser] = useState<UserRow | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<UserRow | null>(null)

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
  const [deleteSalesOrderMode, setDeleteSalesOrderMode] = useState<'keep_text' | 'transfer_user'>('keep_text')
  const [deleteTransferToUserId, setDeleteTransferToUserId] = useState('')
  const [deleteError, setDeleteError] = useState('')
  function openCreate() {
    setName(''); setEmail(''); setPassword(''); setRole('WAREHOUSE'); setSupplierId(''); setError('')
    setShowCreate(true)
  }

  function openEdit(u: UserRow) {
    setEditName(u.name); setEditEmail(u.email); setEditRole(u.role)
    setEditSupplierId(u.supplierId ?? ''); setEditPassword(''); setEditActive(u.active); setEditError('')
    setEditUser(u)
  }

  function openDelete(u: UserRow) {
    const firstTransferTarget = users.find((candidate) => candidate.id !== u.id && candidate.active)
    setDeleteSalesOrderMode('keep_text')
    setDeleteTransferToUserId(firstTransferTarget?.id ?? '')
    setDeleteError('')
    setDeleteTarget(u)
  }

  function handleCreate() {
    setError('')
    startCreateTransition(async () => {
      const result = await createUser({ name, email, password, role, supplierId: role === 'SUPPLIER' ? supplierId : undefined })
      if (result.success) { setShowCreate(false); router.refresh() }
      else setError(result.error ?? 'Failed')
    })
  }

  function handleUpdate() {
    if (!editUser) return
    setEditError('')
    startUpdateTransition(async () => {
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

  function handleDelete() {
    if (!deleteTarget) return
    setDeleteError('')
    startDeleteTransition(async () => {
      const result = await deleteUser(deleteTarget.id, {
        salesOrderMode: deleteSalesOrderMode,
        transferToUserId: deleteSalesOrderMode === 'transfer_user' ? deleteTransferToUserId : undefined,
      })
      if (result.success) { setDeleteTarget(null); router.refresh() }
      else setDeleteError(result.error ?? 'Failed')
    })
  }

  const transferOptions = deleteTarget
    ? users.filter((user) => user.id !== deleteTarget.id && user.active)
    : []

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <span className="text-sm text-muted-foreground">{users.length} user(s)</span>
        <Button size="sm" onClick={openCreate}><Plus className="h-4 w-4 mr-1" />Add User</Button>
      </div>

      {/* Users table */}
      <Table className="rounded-md border min-w-[700px]">
        <TableHeader className="bg-muted/50">
          <TableRow>
            <TableHead className="px-4 text-xs">Name</TableHead>
            <TableHead className="px-4 text-xs">Email</TableHead>
            <TableHead className="px-4 text-xs">Role</TableHead>
            <TableHead className="px-4 text-xs">Supplier</TableHead>
            <TableHead className="px-4 text-xs">Status</TableHead>
            <TableHead className="px-4 text-xs">2FA</TableHead>
            <TableHead className="px-4 text-xs">Last Login</TableHead>
            <TableHead className="px-4 w-10" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {users.map((u) => (
            <TableRow key={u.id} className={!u.active ? 'opacity-50' : ''}>
              <TableCell className="px-4 font-medium">{u.name}</TableCell>
              <TableCell className="px-4 text-muted-foreground">{u.email}</TableCell>
              <TableCell className="px-4">
                <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${ROLE_BADGE[u.role] ?? ''}`}>
                  {u.role}
                </span>
              </TableCell>
              <TableCell className="px-4 text-xs text-muted-foreground">{u.supplierName ?? '—'}</TableCell>
              <TableCell className="px-4">
                {u.active
                  ? <span className="text-xs text-green-600 font-medium">Active</span>
                  : <span className="text-xs text-muted-foreground">Inactive</span>
                }
              </TableCell>
              <TableCell className="px-4 text-xs">{u.totpEnabled ? '✓' : '—'}</TableCell>
              <TableCell className="px-4 text-xs text-muted-foreground">
                {u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : 'Never'}
              </TableCell>
              <TableCell className="px-4">
                <div className="flex items-center justify-end gap-1">
                  <button type="button" onClick={() => openEdit(u)} className="text-muted-foreground hover:text-foreground" aria-label={`Edit ${u.email}`}>
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button type="button" onClick={() => openDelete(u)} className="text-destructive/80 hover:text-destructive" aria-label={`Delete ${u.email}`}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

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
        <Dialog open onOpenChange={(open) => {
          if (!open && !isCreatePending) setShowCreate(false)
        }}><DialogContent showCloseButton={false} className="max-w-md sm:max-w-md">
          <DialogHeader><DialogTitle>Add User</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5"><Label>Name *</Label><Input value={name} onChange={(e) => setName(e.target.value)} className="h-9 text-sm" /></div>
            <div className="space-y-1.5"><Label>Email *</Label><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} className="h-9 text-sm" /></div>
            <div className="space-y-1.5"><Label>Password *</Label><Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Min 8 characters" className="h-9 text-sm" /></div>
            <div className="space-y-1.5">
              <Label>Role *</Label>
              <Select value={role} onChange={(e) => setRole(e.target.value)} className="h-9 px-3">
                {ROLES.map((r) => (<option key={r.value} value={r.value}>{r.label} — {r.description}</option>))}
              </Select>
            </div>
            {role === 'SUPPLIER' && (
              <div className="space-y-1.5">
                <Label>Linked Supplier *</Label>
                <Select value={supplierId} onChange={(e) => setSupplierId(e.target.value)} className="h-9 px-3">
                  <option value="">Select supplier…</option>
                  {suppliers.map((s) => (<option key={s.id} value={s.id}>{s.name}</option>))}
                </Select>
              </div>
            )}
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreate(false)} disabled={isCreatePending}>Cancel</Button>
            <Button onClick={handleCreate} disabled={isCreatePending}>{isCreatePending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}Create User</Button>
          </DialogFooter>
        </DialogContent></Dialog>
      )}

      {/* Edit dialog */}
      {editUser && (
        <Dialog open onOpenChange={(open) => {
          if (!open && !isUpdatePending) setEditUser(null)
        }}><DialogContent showCloseButton={false} className="max-w-md sm:max-w-md">
          <DialogHeader><DialogTitle>Edit User</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5"><Label>Name</Label><Input value={editName} onChange={(e) => setEditName(e.target.value)} className="h-9 text-sm" /></div>
            <div className="space-y-1.5"><Label>Email</Label><Input type="email" value={editEmail} onChange={(e) => setEditEmail(e.target.value)} className="h-9 text-sm" /></div>
            <div className="space-y-1.5"><Label>New Password</Label><Input type="password" value={editPassword} onChange={(e) => setEditPassword(e.target.value)} placeholder="Leave blank to keep current" className="h-9 text-sm" /></div>
            <div className="space-y-1.5">
              <Label>Role</Label>
              <Select value={editRole} onChange={(e) => setEditRole(e.target.value)} className="h-9 px-3">
                {ROLES.map((r) => (<option key={r.value} value={r.value}>{r.label}</option>))}
              </Select>
            </div>
            {editRole === 'SUPPLIER' && (
              <div className="space-y-1.5">
                <Label>Linked Supplier</Label>
                <Select value={editSupplierId} onChange={(e) => setEditSupplierId(e.target.value)} className="h-9 px-3">
                  <option value="">Select supplier…</option>
                  {suppliers.map((s) => (<option key={s.id} value={s.id}>{s.name}</option>))}
                </Select>
              </div>
            )}
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={editActive} onChange={(e) => setEditActive(e.target.checked)} className="rounded border-input" />
              <span className="text-sm">Active</span>
            </label>
            {editError && <p className="text-sm text-destructive">{editError}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditUser(null)} disabled={isUpdatePending}>Cancel</Button>
            <Button onClick={handleUpdate} disabled={isUpdatePending}>{isUpdatePending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}Save Changes</Button>
          </DialogFooter>
        </DialogContent></Dialog>
      )}

      {/* Delete dialog */}
      {deleteTarget && (
        <Dialog open onOpenChange={(open) => {
          if (!open && !isDeletePending) setDeleteTarget(null)
        }}><DialogContent showCloseButton={false} className="max-w-md sm:max-w-md">
          <DialogHeader><DialogTitle className="text-destructive">Delete User</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm">
              <p className="font-medium text-destructive">This action is irreversible.</p>
              <p className="mt-1">
                Delete <span className="font-medium">{deleteTarget.name}</span> and choose how their existing sales orders should be handled.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label>Sales Orders</Label>
              <label className="flex items-start gap-2 rounded-md border p-3 text-sm cursor-pointer">
                <input
                  type="radio"
                  name="delete-sales-order-mode"
                  value="keep_text"
                  checked={deleteSalesOrderMode === 'keep_text'}
                  onChange={() => setDeleteSalesOrderMode('keep_text')}
                  className="mt-0.5"
                />
                <span>Keep the deleted user&apos;s name as plain text on existing sales orders.</span>
              </label>
              <label className="flex items-start gap-2 rounded-md border p-3 text-sm cursor-pointer">
                <input
                  type="radio"
                  name="delete-sales-order-mode"
                  value="transfer_user"
                  checked={deleteSalesOrderMode === 'transfer_user'}
                  onChange={() => setDeleteSalesOrderMode('transfer_user')}
                  className="mt-0.5"
                />
                <span>Reassign existing sales orders to another active user.</span>
              </label>
            </div>
            {deleteSalesOrderMode === 'transfer_user' && (
              <div className="space-y-1.5">
                <Label>Transfer Sales Orders To *</Label>
                <Select
                  value={deleteTransferToUserId}
                  onChange={(e) => setDeleteTransferToUserId(e.target.value)}
                  disabled={transferOptions.length === 0}
                  className="h-9 px-3"
                >
                  <option value="">Select user…</option>
                  {transferOptions.map((user) => (
                    <option key={user.id} value={user.id}>{user.name} — {user.email} ({user.role})</option>
                  ))}
                </Select>
                {transferOptions.length === 0 && (
                  <p className="text-sm text-destructive">No other active user is available to receive transferred sales orders.</p>
                )}
              </div>
            )}
            {deleteSalesOrderMode === 'keep_text' && (
              <p className="text-sm text-muted-foreground">
                Historical sales orders will continue to show {deleteTarget.name} as text after the user account is deleted.
              </p>
            )}
            {deleteSalesOrderMode === 'transfer_user' && transferOptions.length > 0 && (
              <p className="text-sm text-muted-foreground">
                Existing sales orders assigned to {deleteTarget.name} will be reassigned before the account is deleted.
              </p>
            )}
            {deleteError && <p className="text-sm text-destructive">{deleteError}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)} disabled={isDeletePending}>Cancel</Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={isDeletePending || (deleteSalesOrderMode === 'transfer_user' && (!deleteTransferToUserId || transferOptions.length === 0))}
            >
              {isDeletePending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}Delete User
            </Button>
          </DialogFooter>
        </DialogContent></Dialog>
      )}
    </div>
  )
}
