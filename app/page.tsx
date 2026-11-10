import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth'
import { homePathForRole } from '@/lib/auth/role-home'

export default async function RootPage() {
  const session = await auth()
  redirect(homePathForRole(session?.user?.role))
}
