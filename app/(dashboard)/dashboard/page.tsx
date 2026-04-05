import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Dashboard' }

export default function Page() {
  return (
    <div>
      <h1 className="text-2xl font-semibold capitalize">dashboard</h1>
      <p className="mt-2 text-muted-foreground">This module is under construction.</p>
    </div>
  )
}
