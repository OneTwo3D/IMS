import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Analytics' }

export default function Page() {
  return (
    <div>
      <h1 className="text-2xl font-semibold capitalize">analytics</h1>
      <p className="mt-2 text-muted-foreground">This module is under construction.</p>
    </div>
  )
}
