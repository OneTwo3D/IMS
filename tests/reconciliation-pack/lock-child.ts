// A child process that takes the run lock for real. Mode "die": exit at once, lock left behind. Mode "hold": say so, then stay alive until stdin closes.
import { acquireRunLock } from '../../lib/reconciliation-pack/lock.ts'

const [dir, mode] = [process.argv[2]!, process.argv[3]!]
const result = acquireRunLock(dir)
if (!result.ok) { console.log(`refused ${result.code}`); process.exit(2) }
if (mode === 'die') { console.log('locked'); process.exit(0) }
console.log('locked')
process.stdin.resume()
process.stdin.on('end', () => process.exit(0))
