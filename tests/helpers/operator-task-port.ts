import { wmsOperatorTaskHash, type WmsOperatorTaskInput } from '../../lib/domain/wms/operator-tasks.ts'

/**
 * An in-memory stand-in for the port's operator-task writes: records every task once (the real table's dedupe key), so a test can assert what an
 * operator would be asked to do. IMS writes no comment to the warehouse; "what did the sweep tell the warehouse" is now "which tasks were raised".
 */
export function recordingTaskPort(options: { failWith?: () => Error | null } = {}) {
  const tasks: WmsOperatorTaskInput[] = []
  const seen = new Set<string>()
  return {
    tasks,
    raiseOperatorTask: async (task: WmsOperatorTaskInput): Promise<boolean> => {
      const failure = options.failWith?.()
      if (failure) throw failure
      const key = [task.connector, task.orderId, task.externalOrderId, task.reason, wmsOperatorTaskHash(task)].join('|')
      if (seen.has(key)) return false
      seen.add(key)
      tasks.push(task)
      return true
    },
    countOpenOperatorTasks: async (): Promise<number> => tasks.length,
  }
}
