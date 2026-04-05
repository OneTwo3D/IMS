import type { Metadata } from 'next'
import { getCustomers } from '@/app/actions/customers'
import { ContactsClient } from './contacts-client'

export const metadata: Metadata = { title: 'Customers' }

export default async function ContactsPage() {
  const customers = await getCustomers(false)
  return <ContactsClient initialCustomers={customers} />
}
