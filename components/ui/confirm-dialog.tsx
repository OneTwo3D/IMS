'use client'

import * as React from 'react'
import { AlertTriangle, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { isConfirmReady } from '@/lib/typed-confirmation'

export type ConfirmDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  /** States exactly what will happen. */
  description: React.ReactNode
  confirmLabel: string
  cancelLabel?: string
  /** Styles the confirm button as destructive. */
  destructive?: boolean
  /** Operator must type this exact value before the confirm button enables. */
  typedConfirmation?: { expected: string; prompt?: string }
  /** Operator must tick this statement before the confirm button enables. */
  acknowledgement?: string
  pending?: boolean
  error?: string | null
  onConfirm: (typed: string) => void
}

/**
 * Reusable confirmation dialog. The confirm button stays disabled until every requirement the caller
 * set (typed value, ticked statement) is met. Pair it with a server-side confirmation check
 * (lib/typed-confirmation.ts) so the protection is not UI-only.
 */
export function ConfirmDialog(props: ConfirmDialogProps) {
  // Mount the body only while open so typed text / ticks never carry over between uses.
  return (
    <Dialog open={props.open} onOpenChange={(next) => { if (!props.pending) props.onOpenChange(next) }}>
      {props.open ? <ConfirmDialogBody {...props} /> : null}
    </Dialog>
  )
}

function ConfirmDialogBody({
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel = 'Cancel',
  destructive = false,
  typedConfirmation,
  acknowledgement,
  pending = false,
  error,
  onConfirm,
}: ConfirmDialogProps) {
  const [typed, setTyped] = React.useState('')
  const [acknowledged, setAcknowledged] = React.useState(false)
  const canConfirm = isConfirmReady({
    typedExpected: typedConfirmation?.expected,
    typed,
    acknowledgementRequired: Boolean(acknowledgement),
    acknowledged,
    pending,
  })

  return (
    <DialogContent showCloseButton={false} className="max-w-md sm:max-w-md">
      <DialogHeader>
        <DialogTitle className={destructive ? 'flex items-center gap-2 text-destructive' : 'flex items-center gap-2'}>
          {destructive ? <AlertTriangle className="h-5 w-5" aria-hidden="true" /> : null}
          {title}
        </DialogTitle>
        <DialogDescription render={<div />} className="space-y-2 text-sm text-foreground">
          {description}
        </DialogDescription>
      </DialogHeader>
      {typedConfirmation ? (
        <div className="space-y-1.5">
          <Label htmlFor="confirm-dialog-typed">
            {typedConfirmation.prompt ?? 'Type'} <code className="rounded bg-muted px-1 text-xs font-bold">{typedConfirmation.expected}</code> to confirm
          </Label>
          <Input
            id="confirm-dialog-typed"
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            autoComplete="off"
            autoFocus
            className="h-9 font-mono text-sm"
          />
        </div>
      ) : null}
      {acknowledgement ? (
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4"
            checked={acknowledged}
            onChange={(event) => setAcknowledged(event.target.checked)}
          />
          <span>{acknowledgement}</span>
        </label>
      ) : null}
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
          {cancelLabel}
        </Button>
        <Button
          type="button"
          variant={destructive ? 'destructive' : 'default'}
          disabled={!canConfirm}
          onClick={() => onConfirm(typed.trim())}
        >
          {pending ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
          {confirmLabel}
        </Button>
      </DialogFooter>
    </DialogContent>
  )
}
