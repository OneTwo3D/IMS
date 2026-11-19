'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { confirmAsnCancelRequestAction, type ConfirmAsnCancelRequestResult } from '@/app/actions/refused-actions'
import { useStepUpReauth, isFreshAuthFailure } from '@/components/auth/use-step-up-reauth'

/** The copy-ready query for an ASN IMS closed after a dispatch cancel, and Done once it was raised in the warehouse's own system. */
export function AsnCancelRequestActions({ id, queryText }: { id: string; queryText: string }) {
  const router = useRouter()
  const { promptReauth, stepUpDialog } = useStepUpReauth()
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(queryText)
      setCopied(true)
    } catch {
      setError('The text could not be copied. Select it and copy it by hand.')
    }
  }

  function done() {
    setError('')
    startTransition(async () => {
      let result: ConfirmAsnCancelRequestResult = await confirmAsnCancelRequestAction(id)
      if (isFreshAuthFailure(result) && (await promptReauth())) result = await confirmAsnCancelRequestAction(id)
      if (isFreshAuthFailure(result)) return setError('A fresh sign-in is needed to mark this done.')
      if (!('success' in result) || result.success !== true) return setError(('error' in result && result.error) || 'The request was not marked done.')
      router.refresh()
    })
  }

  return (
    <div className="space-y-2">
      <p className="rounded bg-muted p-2 text-sm select-all">{queryText}</p>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex gap-2">
        <Button size="sm" variant="outline" onClick={copy}>{copied ? 'Copied' : 'Copy text'}</Button>
        <Button size="sm" disabled={isPending} onClick={done}>Done: warehouse asked</Button>
      </div>
      {stepUpDialog}
    </div>
  )
}
