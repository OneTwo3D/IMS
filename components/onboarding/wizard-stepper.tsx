'use client'

import { Check, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

export type StepDef = {
  key: string
  label: string
  icon: LucideIcon
  skippable: boolean
}

type Props = {
  steps: StepDef[]
  currentStep: number
  completedSteps: Set<string>
  isStepAccessible: (index: number) => boolean
  onStepClick: (index: number) => void
}

export function WizardStepper({ steps, currentStep, completedSteps, isStepAccessible, onStepClick }: Props) {
  return (
    <nav className="flex flex-col gap-1" aria-label="Setup progress">
      {steps.map((step, i) => {
        const isActive = i === currentStep
        const isComplete = completedSteps.has(step.key)
        const isAccessible = isStepAccessible(i)
        const Icon = step.icon

        return (
          <button
            key={step.key}
            type="button"
            onClick={() => onStepClick(i)}
            disabled={!isAccessible}
            className={cn(
              'flex items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm transition-colors',
              isActive
                ? 'bg-primary/10 text-primary font-medium'
                : isComplete
                  ? 'text-muted-foreground hover:bg-muted/50'
                  : isAccessible
                    ? 'text-muted-foreground/60 hover:bg-muted/50'
                    : 'cursor-not-allowed text-muted-foreground/40',
            )}
          >
            <span
              className={cn(
                'flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-xs',
                isActive
                  ? 'border-primary bg-primary text-primary-foreground'
                  : isComplete
                    ? 'border-primary/40 bg-primary/10 text-primary'
                    : 'border-border bg-background text-muted-foreground/60',
              )}
            >
              {isComplete ? <Check className="h-3.5 w-3.5" /> : <Icon className="h-3.5 w-3.5" />}
            </span>
            <span className="truncate">{step.label}</span>
          </button>
        )
      })}
    </nav>
  )
}
