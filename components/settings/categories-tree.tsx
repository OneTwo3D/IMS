'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { ChevronRight, ChevronDown, Pencil, Trash2, Plus, Check, X, MoveRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { createCategory, deleteCategory, moveCategory, renameCategory } from '@/app/actions/categories'
import type { ProductCategoryNode } from '@/lib/products/categories'

type TreeNode = ProductCategoryNode & { children: TreeNode[] }

function buildTree(nodes: ProductCategoryNode[]): TreeNode[] {
  const byId = new Map<string, TreeNode>()
  for (const n of nodes) byId.set(n.id, { ...n, children: [] })
  const roots: TreeNode[] = []
  for (const n of byId.values()) {
    if (n.parentId && byId.has(n.parentId)) {
      byId.get(n.parentId)!.children.push(n)
    } else {
      roots.push(n)
    }
  }
  const sortByName = (a: TreeNode, b: TreeNode) => a.name.localeCompare(b.name, 'en-US', { sensitivity: 'base' })
  function sort(t: TreeNode[]) { t.sort(sortByName); for (const n of t) sort(n.children) }
  sort(roots)
  return roots
}

export function CategoriesTree({ categories }: { categories: ProductCategoryNode[] }) {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [newTopName, setNewTopName] = useState('')
  const [isPending, startTransition] = useTransition()
  const tree = useMemo(() => buildTree(categories), [categories])

  function withResult(action: () => Promise<{ ok: boolean; error?: string }>) {
    setError(null)
    startTransition(async () => {
      const res = await action()
      if (!res.ok) setError(res.error ?? 'Action failed')
      router.refresh()
    })
  }

  return (
    <div className="space-y-3">
      {error && (
        <p className="text-sm text-destructive">{error}</p>
      )}
      <div className="flex items-center gap-2">
        <Input
          value={newTopName}
          onChange={(e) => setNewTopName(e.target.value)}
          placeholder="New top-level category"
          className="max-w-xs h-8 text-sm"
          disabled={isPending}
        />
        <Button
          size="sm"
          disabled={isPending || newTopName.trim().length === 0}
          onClick={() => withResult(async () => {
            const res = await createCategory({ name: newTopName, parentId: null })
            if (res.ok) setNewTopName('')
            return res
          })}
        >
          <Plus className="h-3.5 w-3.5 mr-1" />
          Add
        </Button>
      </div>

      {tree.length === 0 ? (
        <p className="text-sm text-muted-foreground py-2">No categories yet. Add the first one above.</p>
      ) : (
        <div className="rounded-md border">
          {tree.map((node) => (
            <TreeRow
              key={node.id}
              node={node}
              depth={0}
              allCategories={categories}
              isPending={isPending}
              withResult={withResult}
            />
          ))}
        </div>
      )}
    </div>
  )
}

type TreeRowProps = {
  node: TreeNode
  depth: number
  allCategories: ProductCategoryNode[]
  isPending: boolean
  withResult: (fn: () => Promise<{ ok: boolean; error?: string }>) => void
}

function TreeRow({ node, depth, allCategories, isPending, withResult }: TreeRowProps) {
  const [open, setOpen] = useState(depth < 1)
  const [editing, setEditing] = useState(false)
  const [renameValue, setRenameValue] = useState(node.name)
  const [addingChild, setAddingChild] = useState(false)
  const [childName, setChildName] = useState('')
  const [moving, setMoving] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const hasChildren = node.children.length > 0

  return (
    <>
      <div
        className="flex items-center gap-1 border-b last:border-b-0 px-2 py-1.5 hover:bg-muted/30"
        style={{ paddingLeft: 8 + depth * 20 }}
      >
        <button
          type="button"
          className="h-5 w-5 flex items-center justify-center text-muted-foreground hover:text-foreground"
          onClick={() => setOpen((v) => !v)}
          aria-label={hasChildren ? (open ? 'Collapse' : 'Expand') : undefined}
          disabled={!hasChildren}
        >
          {hasChildren ? (open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />) : null}
        </button>

        {editing ? (
          <div className="flex items-center gap-1 flex-1">
            <Input
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              className="h-7 text-sm flex-1"
              autoFocus
              disabled={isPending}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  withResult(async () => {
                    const res = await renameCategory({ id: node.id, name: renameValue })
                    if (res.ok) setEditing(false)
                    return res
                  })
                } else if (e.key === 'Escape') {
                  setEditing(false)
                  setRenameValue(node.name)
                }
              }}
            />
            <Button size="icon" variant="ghost" className="h-7 w-7" disabled={isPending} onClick={() => withResult(async () => {
              const res = await renameCategory({ id: node.id, name: renameValue })
              if (res.ok) setEditing(false)
              return res
            })}>
              <Check className="h-3.5 w-3.5" />
            </Button>
            <Button size="icon" variant="ghost" className="h-7 w-7" disabled={isPending} onClick={() => { setEditing(false); setRenameValue(node.name) }}>
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        ) : (
          <span className="text-sm flex-1">{node.name}</span>
        )}

        {!editing && (
          <div className="flex items-center gap-0.5 opacity-70 hover:opacity-100">
            <Button size="icon" variant="ghost" className="h-7 w-7" title="Add sub-category" disabled={isPending} onClick={() => setAddingChild(true)}>
              <Plus className="h-3.5 w-3.5" />
            </Button>
            <Button size="icon" variant="ghost" className="h-7 w-7" title="Rename" disabled={isPending} onClick={() => { setRenameValue(node.name); setEditing(true) }}>
              <Pencil className="h-3.5 w-3.5" />
            </Button>
            <Button size="icon" variant="ghost" className="h-7 w-7" title="Move to different parent" disabled={isPending} onClick={() => setMoving(true)}>
              <MoveRight className="h-3.5 w-3.5" />
            </Button>
            <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive" title="Delete" disabled={isPending} onClick={() => setDeleting(true)}>
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}
      </div>

      {addingChild && (
        <div className="flex items-center gap-1 border-b px-2 py-1.5 bg-muted/20" style={{ paddingLeft: 8 + (depth + 1) * 20 }}>
          <Input
            value={childName}
            onChange={(e) => setChildName(e.target.value)}
            placeholder="New sub-category name"
            className="h-7 text-sm flex-1"
            autoFocus
            disabled={isPending}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                withResult(async () => {
                  const res = await createCategory({ name: childName, parentId: node.id })
                  if (res.ok) { setAddingChild(false); setChildName(''); setOpen(true) }
                  return res
                })
              } else if (e.key === 'Escape') {
                setAddingChild(false); setChildName('')
              }
            }}
          />
          <Button size="sm" disabled={isPending || childName.trim().length === 0} onClick={() => withResult(async () => {
            const res = await createCategory({ name: childName, parentId: node.id })
            if (res.ok) { setAddingChild(false); setChildName(''); setOpen(true) }
            return res
          })}>
            <Check className="h-3.5 w-3.5" />
          </Button>
          <Button size="sm" variant="ghost" disabled={isPending} onClick={() => { setAddingChild(false); setChildName('') }}>
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}

      {open && node.children.map((child) => (
        <TreeRow
          key={child.id}
          node={child}
          depth={depth + 1}
          allCategories={allCategories}
          isPending={isPending}
          withResult={withResult}
        />
      ))}

      <Dialog open={moving} onOpenChange={(o) => { if (!o) setMoving(false) }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Move &ldquo;{node.name}&rdquo;</DialogTitle>
            <DialogDescription>
              Choose a new parent. The whole subtree moves with it. Pick &ldquo;(top level)&rdquo; to make it a root category.
            </DialogDescription>
          </DialogHeader>
          <MoveForm
            node={node}
            allCategories={allCategories}
            isPending={isPending}
            onClose={() => setMoving(false)}
            onMove={(newParentId) => withResult(async () => {
              const res = await moveCategory({ id: node.id, newParentId })
              if (res.ok) setMoving(false)
              return res
            })}
          />
        </DialogContent>
      </Dialog>

      <Dialog open={deleting} onOpenChange={(o) => { if (!o) setDeleting(false) }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Delete &ldquo;{node.name}&rdquo;?</DialogTitle>
            <DialogDescription>
              Direct child categories will be promoted one level up. Products currently linked to this category will be reassigned to its parent ({node.parentId ? 'the parent category' : 'no category'}). This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter showCloseButton>
            <Button
              variant="destructive"
              disabled={isPending}
              onClick={() => withResult(async () => {
                const res = await deleteCategory({ id: node.id })
                if (res.ok) setDeleting(false)
                return res
              })}
            >
              Delete category
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

function MoveForm({
  node,
  allCategories,
  isPending,
  onClose,
  onMove,
}: {
  node: TreeNode
  allCategories: ProductCategoryNode[]
  isPending: boolean
  onClose: () => void
  onMove: (newParentId: string | null) => void
}) {
  // Exclude self and all descendants from candidate parents.
  const forbidden = useMemo(() => {
    const childrenByParent = new Map<string, string[]>()
    for (const c of allCategories) {
      if (!c.parentId) continue
      const arr = childrenByParent.get(c.parentId) ?? []
      arr.push(c.id)
      childrenByParent.set(c.parentId, arr)
    }
    const set = new Set<string>([node.id])
    const stack = [...(childrenByParent.get(node.id) ?? [])]
    while (stack.length > 0) {
      const id = stack.pop()!
      if (set.has(id)) continue
      set.add(id)
      for (const childId of childrenByParent.get(id) ?? []) stack.push(childId)
    }
    return set
  }, [node.id, allCategories])

  const candidates = allCategories
    .filter((c) => !forbidden.has(c.id))
    .sort((a, b) => a.path.localeCompare(b.path, 'en-US', { sensitivity: 'base' }))

  const [parentId, setParentId] = useState<string>('')

  return (
    <div className="space-y-3">
      <Select
        value={parentId}
        onChange={(e) => setParentId(e.target.value)}
        disabled={isPending}
      >
        <option value="">(top level)</option>
        {candidates.map((c) => (
          <option key={c.id} value={c.id}>{c.path}</option>
        ))}
      </Select>
      <DialogFooter showCloseButton>
        <Button variant="outline" onClick={onClose} disabled={isPending}>Cancel</Button>
        <Button disabled={isPending} onClick={() => onMove(parentId || null)}>Move</Button>
      </DialogFooter>
    </div>
  )
}
