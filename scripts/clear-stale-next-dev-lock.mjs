import { readFile, readlink, rm } from 'node:fs/promises'
import { cwd } from 'node:process'

const lockPath = '.next/dev/lock'
const turbopackCachePath = '.next/dev/cache/turbopack'

async function removeLock() {
  await rm(lockPath, { force: true })
}

async function clearDevCache() {
  await rm(turbopackCachePath, { recursive: true, force: true })
}

async function readProcFile(path) {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

async function readProcLink(path) {
  try {
    return await readlink(path)
  } catch {
    return null
  }
}

async function pidLooksLikeThisNextDev(pid) {
  const cmdline = await readProcFile(`/proc/${pid}/cmdline`)
  if (!cmdline) {
    return false
  }

  const args = cmdline.split('\0').filter(Boolean)
  const command = args.join(' ')
  const hasNextDevCommand = command.includes('next') && command.includes('dev')
  if (!hasNextDevCommand) {
    return false
  }

  const procCwd = await readProcLink(`/proc/${pid}/cwd`)
  if (procCwd) {
    return procCwd.trim() === cwd()
  }

  // /proc/<pid>/cwd is a symlink and may be unreadable on some platforms.
  // If the command is clearly next dev, preserve the lock rather than
  // risking two dev servers.
  return true
}

try {
  const raw = await readFile(lockPath, 'utf8')
  const lock = JSON.parse(raw)
  const pid = Number(lock.pid)
  if (!Number.isInteger(pid) || pid <= 0) {
    await removeLock()
    await clearDevCache()
    process.exit(0)
  }
  try {
    process.kill(pid, 0)
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH') {
      await removeLock()
      await clearDevCache()
      process.exit(0)
    } else {
      throw error
    }
  }

  if (await pidLooksLikeThisNextDev(pid)) {
    process.exit(0)
  }

  await removeLock()
  await clearDevCache()
} catch (error) {
  if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
    await clearDevCache()
    process.exit(0)
  }
  throw error
}
