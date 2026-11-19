/**
 * Company grouping keys (CRM foundation). Pure functions, no I/O.
 *
 * Two customers are in one company group when EITHER key matches:
 *   1. the BILLING COMPANY NAME   -> NFC, lower-cased, full stops and commas dropped, runs of whitespace collapsed, and TRAILING LEGAL SUFFIXES folded away
 *      (owner decision 2026-11-19): Ltd / Limited, Inc / Incorporated, plc, LLC, GmbH, Co / Company, and a dangling "&" or "and" before them, so "Acme Ltd",
 *      "ACME Limited." and "Acme & Co" are one group. The first word is never removed (a name that is only a suffix keeps it). A false group is only a view an
 *      operator reads: nothing is merged.
 *   2. the EMAIL DOMAIN           -> only a company-owned domain. A free-mail or ISP domain (gmail.com, outlook.com, ...) names nobody's company
 *      and is never a key.
 *
 * A company group never changes which orders belong to a person: it is a read-time lens (the customer page lists the other customers of the group), nothing
 * is merged and nothing is written.
 */
import { normaliseIdentityEmail } from '@/lib/domain/crm/identity-key'

/** Mailbox providers whose domain says nothing about an employer. Deliberately a short, boring list: a miss only makes a group too large to be useful, never wrong data. */
export const FREE_MAIL_DOMAINS: ReadonlySet<string> = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'outlook.co.uk', 'hotmail.com', 'hotmail.co.uk', 'live.com', 'live.co.uk', 'msn.com',
  'yahoo.com', 'yahoo.co.uk', 'ymail.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com', 'aol.co.uk', 'proton.me', 'protonmail.com',
  'gmx.com', 'gmx.net', 'gmx.de', 'web.de', 'mail.com', 'zoho.com', 'btinternet.com', 'sky.com', 'talktalk.net', 'virginmedia.com',
  'ntlworld.com', 'blueyonder.co.uk', 'tiscali.co.uk', 'orange.fr', 'wanadoo.fr', 'free.fr', 'laposte.net', 't-online.de', 'freenet.de',
  'libero.it', 'virgilio.it', 'tiscali.it', 'wp.pl', 'o2.pl', 'onet.pl', 'interia.pl', 'seznam.cz', 'centrum.cz', 'mail.ru', 'yandex.ru',
  'qq.com', '163.com', '126.com',
])

/** The trailing words folded away. The SQL twin (company-group.ts COMPANY_NAME_KEY_SQL) lists the same words. */
export const LEGAL_SUFFIX_WORDS: ReadonlySet<string> = new Set(['ltd', 'limited', 'inc', 'incorporated', 'plc', 'llc', 'gmbh', 'co', 'company', '&', 'and'])

/** The normalised company name (legal suffixes folded), or null when there is none. */
export function companyNameKey(company: string | null | undefined): string | null {
  if (typeof company !== 'string') return null
  const key = company.normalize('NFC').toLowerCase().replace(/[.,]/g, '').replace(/\s+/g, ' ').trim()
  if (key === '') return null
  const words = key.split(' ')
  while (words.length > 1 && LEGAL_SUFFIX_WORDS.has(words[words.length - 1]!)) words.pop()
  return words.join(' ')
}

/** The email domain when it belongs to a company, or null (no usable email, or a free-mail provider). */
export function companyEmailDomain(email: string | null | undefined): string | null {
  const key = normaliseIdentityEmail(email)
  if (key === null) return null
  const domain = key.split('@')[1]!
  return FREE_MAIL_DOMAINS.has(domain) ? null : domain
}

/** The two keys a customer is grouped by. Two customers are in the same company group when their name keys are equal OR their company domains are equal. */
export function companyKeys(input: { company: string | null | undefined; email: string | null | undefined }): { nameKey: string | null; domain: string | null } {
  return { nameKey: companyNameKey(input.company), domain: companyEmailDomain(input.email) }
}

/** True when two customers belong to the same company group. */
export function sameCompany(a: { nameKey: string | null; domain: string | null }, b: { nameKey: string | null; domain: string | null }): boolean {
  return (a.nameKey !== null && a.nameKey === b.nameKey) || (a.domain !== null && a.domain === b.domain)
}
