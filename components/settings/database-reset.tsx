'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { AlertTriangle, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { resetDatabase, type ResetLevel } from '@/app/actions/reset'

const LEVELS: { key: ResetLevel; label: string; description: string; items: string[] }[] = [
  {
    key: 'transactions',
    label: 'Reset Transactions Only',
    description: 'Deletes all orders, purchases, stock movements, invoices, payments, and receipts. Keeps products, suppliers, customers, warehouses, and settings.',
    items: ['Sales orders + lines + refunds + payments', 'Purchase orders + lines + receipts + returns + invoices', 'Stock movements + levels + cost layers + COGS entries', 'Stock transfers', 'Sync logs + activity logs'],
  },
  {
    key: 'products',
    label: 'Reset Transactions + Products',
    description: 'Everything above, plus all products, BOMs, kits, variants, suppliers, and customers.',
    items: ['Everything in "Transactions Only"', 'All products (including variants, BOMs, kits)', 'Product components + options', 'Suppliers + supplier products', 'Customers'],
  },
  {
    key: 'full',
    label: 'Full Database Reset',
    description: 'Resets everything except user accounts. This is irreversible.',
    items: ['Everything in "Transactions + Products"', 'Warehouses', 'Currencies + FX rates', 'Tax rates', 'Purchase units', 'Adjustment reasons', 'All settings', 'Organisation details', 'Note: user accounts are preserved'],
  },
]

export function DatabaseReset() {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [showDialog, setShowDialog] = useState(false)
  const [selectedLevel, setSelectedLevel] = useState<ResetLevel | null>(null)
  const [confirmation, setConfirmation] = useState('')
  const [result, setResult] = useState<{ message: string; isError: boolean } | null>(null)

  const level = LEVELS.find((l) => l.key === selectedLevel)
  const confirmText = selectedLevel === 'full' ? 'RESET EVERYTHING' : selectedLevel === 'products' ? 'RESET PRODUCTS' : 'RESET TRANSACTIONS'
  const isConfirmed = confirmation === confirmText

  function handleReset() {
    if (!selectedLevel || !isConfirmed) return
    setResult(null)
    startTransition(async () => {
      const r = await resetDatabase(selectedLevel)
      if (r.success) {
        setResult({ message: 'Database has been reset successfully.', isError: false })
        setShowDialog(false)
        setConfirmation('')
        setSelectedLevel(null)
        router.refresh()
      } else {
        setResult({ message: r.error ?? 'Reset failed', isError: true })
      }
    })
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-3">
        {LEVELS.map((l) => (
          <div key={l.key} className={`rounded-md border p-4 space-y-2 ${l.key === 'full' ? 'border-destructive/50' : ''}`}>
            <h3 className="text-sm font-medium">{l.label}</h3>
            <p className="text-xs text-muted-foreground">{l.description}</p>
            <ul className="text-xs text-muted-foreground space-y-0.5 list-disc pl-4">
              {l.items.map((item, i) => <li key={i}>{item}</li>)}
            </ul>
            <Button
              variant={l.key === 'full' ? 'destructive' : 'outline'}
              size="sm"
              className="w-full mt-2"
              onClick={() => { setSelectedLevel(l.key); setShowDialog(true); setConfirmation(''); setResult(null) }}
            >
              {l.label}
            </Button>
          </div>
        ))}
      </div>

      {result && (
        <p className={`text-sm ${result.isError ? 'text-destructive' : 'text-green-600'}`}>{result.message}</p>
      )}

      {showDialog && level && (
        <Dialog open onOpenChange={() => {}}>
          <DialogContent showCloseButton={false} className="max-w-md sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-destructive">
                <AlertTriangle className="h-5 w-5" />
                {level.label}
              </DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div className="rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm">
                <p className="font-medium text-destructive">This action is irreversible.</p>
                <p className="text-muted-foreground mt-1">{level.description}</p>
              </div>
              <div className="space-y-1.5">
                <Label>Type <code className="text-xs bg-muted px-1 rounded font-bold">{confirmText}</code> to confirm</Label>
                <Input
                  value={confirmation}
                  onChange={(e) => setConfirmation(e.target.value)}
                  placeholder={confirmText}
                  className="h-9 font-mono text-sm"
                  autoFocus
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => { setShowDialog(false); setConfirmation('') }} disabled={isPending}>Cancel</Button>
              <Button variant="destructive" onClick={handleReset} disabled={isPending || !isConfirmed}>
                {isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                Confirm Reset
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}
