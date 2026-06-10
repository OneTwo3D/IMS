#!/usr/bin/env tsx
/**
 * onetwoInventory CLI
 * Usage: npm run cli -- <command>
 *
 * Commands:
 *   create-user   Interactively create a new user
 *   migrate-encrypted-settings   Re-encrypt sensitive settings with SETTINGS_ENCRYPTION_KEY
 */
import { createInterface } from 'readline'
import bcrypt from 'bcryptjs'
import { db } from '../lib/db/index'
import { bulkMigrateEncryptedSettings } from '../lib/settings-store'
import { validateUserPassword } from '../lib/security/password-policy'

const rl = createInterface({ input: process.stdin, output: process.stdout })
const ask = (q: string): Promise<string> =>
  new Promise((resolve) => rl.question(q, resolve))

async function createUser() {
  console.log('\n--- Create User ---\n')

  const name = await ask('Name: ')
  const email = await ask('Email: ')

  const existing = await db.user.findUnique({ where: { email } })
  if (existing) {
    console.error(`Error: user with email "${email}" already exists.`)
    process.exit(1)
  }

  process.stdout.write('Password: ')
  const password = await new Promise<string>((resolve) => {
    const stdin = process.stdin
    stdin.setRawMode?.(true)
    stdin.resume()
    stdin.setEncoding('utf8')
    let pwd = ''
    stdin.on('data', (ch: string) => {
      if (ch === '\r' || ch === '\n') {
        stdin.setRawMode?.(false)
        stdin.pause()
        console.log('')
        resolve(pwd)
      } else if (ch === '\u0003') {
        process.exit()
      } else {
        pwd += ch
        process.stdout.write('*')
      }
    })
  })

  const policyError = validateUserPassword(password)
  if (policyError) {
    console.error(`Error: ${policyError}.`)
    process.exit(1)
  }

  const passwordHash = await bcrypt.hash(password, 12)
  const user = await db.user.create({
    data: { name, email, passwordHash, role: 'ADMIN', active: true },
  })

  console.log(`\nUser created: ${user.email} (ID: ${user.id})`)
}

async function migrateEncryptedSettings() {
  const result = await bulkMigrateEncryptedSettings()
  console.log(
    [
      `Scanned ${result.scanned} sensitive setting(s).`,
      `Migrated ${result.migrated}.`,
      `Skipped ${result.skipped}.`,
      `Raced ${result.raced}.`,
      `Failed ${result.failed}.`,
    ].join(' '),
  )
  if (result.failed > 0) process.exitCode = 1
}

const command = process.argv[2]

switch (command) {
  case 'create-user':
    createUser()
      .catch(console.error)
      .finally(() => { rl.close(); db.$disconnect() })
    break
  case 'migrate-encrypted-settings':
    migrateEncryptedSettings()
      .catch((error) => {
        console.error(error)
        process.exitCode = 1
      })
      .finally(() => { rl.close(); db.$disconnect() })
    break
  default:
    console.log('Available commands: create-user, migrate-encrypted-settings')
    rl.close()
    db.$disconnect()
}
