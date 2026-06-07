import * as React from "react"
import { cn } from "@/lib/utils"

export function ScrollArea({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="scroll-area" className={cn("overflow-auto", className)} {...props} />
}
