export const dynamic = 'force-dynamic'

import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { Sidebar } from '@/components/layout/sidebar'
import { Topbar } from '@/components/layout/topbar'

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await auth()

  if (!session?.user) redirect('/login')
  if (session.user.totpEnabled && !session.user.totpVerified) redirect('/2fa')

  const org = await db.organisation.findFirst({ select: { name: true, logoUrl: true } })

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar companyName={org?.name} logoUrl={org?.logoUrl} userRole={session.user.role} />
      <div className="flex flex-1 flex-col overflow-hidden">
        <Topbar userName={session.user.name ?? ''} userEmail={session.user.email ?? ''} userPictureUrl={session.user.pictureUrl} />
        <main className="flex-1 overflow-y-auto p-6">{children}</main>
      </div>
    </div>
  )
}
