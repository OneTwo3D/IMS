"use client"

import { Info } from "lucide-react"
import { PageTitle } from "@/lib/page-title"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

/**
 * Report header: title with an info icon that reveals the report's
 * description and methodology notices in a single tooltip on hover or
 * keyboard focus. Previously the description rendered as a paragraph
 * below the title and the notices rendered in a separate amber box
 * lower on the page — the same context appears in one place now so the
 * data table sits higher on the viewport without losing information.
 */
export function ReportPageTitle({
  title,
  description,
  notices = [],
}: {
  title: string
  description: string
  notices?: string[]
}) {
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
          <p>{description}</p>
          {notices.length > 0 && (
            {/*
              LIGATURES OFF, because a notice may carry a fixed-width identity token (o3d-7jfq r8).
              The customer report names contradicted rows with `group=utf16hex:<4 hex digits per
              code unit>`, whose whole value is that the digits line up position against position.
              A font that ligates `ff` into one glyph makes a token look a digit shorter than it is
              and destroys exactly that. Nothing else in a notice needs a ligature, so the cheapest
              honest thing is to suppress them for the list. It is a mitigation and not a proof —
              `identityLabelField` states the glyph ambiguity that remains after it.
            */}
            <ul className="mt-2 space-y-1 border-t border-background/20 pt-2 text-[11px] leading-snug [font-variant-ligatures:none]">
              {notices.map((notice) => (
                <li key={notice}>{notice}</li>
              ))}
            </ul>
          )}
        </TooltipContent>
      </Tooltip>
    </div>
  )
}
