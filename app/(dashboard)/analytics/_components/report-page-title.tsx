"use client"

import { Info } from "lucide-react"
import { PageTitle } from "@/lib/page-title"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

/**
 * Report header: title with an info icon that reveals the explanatory
 * description on hover or keyboard focus. The description used to render
 * as a paragraph below the title on every report page; moving it behind
 * the (i) lets the data sit higher on the viewport without losing the
 * context that finance/ops users occasionally need.
 */
export function ReportPageTitle({ title, description }: { title: string; description: string }) {
  return (
    <div className="flex items-center gap-2">
      <PageTitle title={title} />
      <Tooltip>
        <TooltipTrigger
          type="button"
          aria-label={`About the ${title} report`}
          className="inline-flex h-5 w-5 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Info className="h-4 w-4" />
        </TooltipTrigger>
        <TooltipContent className="max-w-md text-left whitespace-normal">
          {description}
        </TooltipContent>
      </Tooltip>
    </div>
  )
}
