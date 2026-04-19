'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { ArrowRight, Loader2, Sparkles, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { dismissOnboarding } from '@/app/actions/onboarding'

export function OnboardingBanner() {
  const [isPending, startTransition] = useTransition()
  const [hidden, setHidden] = useState(false)

  if (hidden) return null

  function handleDismiss() {
    startTransition(async () => {
      await dismissOnboarding()
      setHidden(true)
    })
  }

  return (
    <Card className="border-primary/30 bg-primary/5 p-4 mb-6">
      <div className="flex items-start gap-4">
        <div className="h-9 w-9 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
          <Sparkles className="h-4.5 w-4.5 text-primary" />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="font-semibold text-sm">Welcome to One Two Inventory</h3>
          <p className="text-sm text-muted-foreground mt-1">
            Complete the setup wizard to configure your company, tax rates, warehouses, integrations, and import your products.
          </p>
          <div className="mt-3">
            <Link href="/onboarding">
              <Button size="sm">
                Complete Setup <ArrowRight className="h-3.5 w-3.5 ml-1.5" />
              </Button>
            </Link>
          </div>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0 shrink-0 text-muted-foreground hover:text-foreground"
          onClick={handleDismiss}
          disabled={isPending}
        >
          {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />}
        </Button>
      </div>
    </Card>
  )
}
