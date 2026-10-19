/**
 * The only filesystem access of the runner core: read a prepared directory, write an evidence file exclusively. No network, no
 * database, no process environment. Everything else in lib/first-load/apply is a pure function of its arguments.
 */
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync, writeSync } from 'node:fs'
import path from 'node:path'

export class PreparedDirError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PreparedDirError'
  }
}

/**
 * Every file of a prepared directory, by name. A subdirectory, a symlink or any non-regular file is refused: the runner only ever
 * loads bytes it can name, and a link could point at something that is not what was prepared.
 */
export function readPreparedDir(dir: string): Map<string, Uint8Array> {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch (error) {
    throw new PreparedDirError('cannot read the prepared directory')
  }
  const files = new Map<string, Uint8Array>()
  for (const name of names.sort()) {
    const full = path.join(dir, name)
    const info = lstatSync(full)
    if (!info.isFile()) throw new PreparedDirError(`the prepared directory holds ${info.isSymbolicLink() ? 'a symbolic link' : 'something that is not a regular file'}: ${/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(name) ? name : '(name withheld)'}`)
    files.set(name, readFileSync(full))
  }
  return files
}

/** Read one file the manifest names; null when it cannot be read (the verifier turns that into a refusal). Symlinks are refused. */
export function readFileOrNull(file: string): Uint8Array | null {
  try {
    if (!lstatSync(file).isFile()) return null
    return readFileSync(file)
  } catch {
    return null
  }
}

/** Create `file` (mode 0600), refusing to overwrite or follow anything that exists, write the bytes and fsync before returning. */
export function writeExclusiveFile(file: string, bytes: Uint8Array): void {
  const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try {
    if (!fstatSync(fd).isFile()) throw new PreparedDirError(`${file} is not a regular file`)
    let written = 0
    while (written < bytes.length) written += writeSync(fd, bytes, written, bytes.length - written)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}
