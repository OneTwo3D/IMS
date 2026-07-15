"use client"

import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"
import { buttonVariants } from "./button-variants"

function Button({
  className,
  variant = "default",
  size = "default",
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

// buttonVariants is deliberately NOT re-exported here: this is a "use client"
// module, so re-exporting it would mark it a client reference and make any
// server component calling buttonVariants() fail at render. Import it from
// "@/components/ui/button-variants" instead (stock shadcn re-exports it; we don't).
export { Button }
