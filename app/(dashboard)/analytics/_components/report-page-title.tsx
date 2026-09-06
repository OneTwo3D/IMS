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
          {/*
              LIGATURES OFF — AN AID, AND EXPLICITLY NOT THE ANSWER (o3d-7jfq r8, corrected r9).
              A notice may carry a fixed-width identity token, `group=utf16hex:<4 hex digits per
              code unit>`. A font that ligates `ff` into one glyph makes such a token LOOK a digit
              shorter than it is, so suppressing ligatures here keeps the digit count honest for
              anyone who glances at one. That costs nothing and it stays.

              What it does NOT do is what round 8 implied it did. It addresses multi-character
              ligatures; it cannot separate the single-glyph pairs `6`/`b`, `1`/`7` or `0`/`8`,
              which is a different collision class entirely — so it was never a mitigation for the
              residue `identityLabelField` names. The real answer is not a better rendering: the
              same token is carried on the row and exported as the `groupToken` CSV column, so an
              operator COPIES it or joins on it and never compares glyphs. See
              `CustomerReportRow.groupToken`. Nothing here is load-bearing for identity.
          */}
          {notices.length > 0 && (
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
