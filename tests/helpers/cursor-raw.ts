/**
 * Stand-in for the pull-cursor write in unit tests.
 *
 * `advancePullCursor` is one raw `INSERT ... ON CONFLICT` statement, which the settings-row doubles
 * in the unit tier cannot interpret, so they route it here and record it as the settings upsert it
 * stands for. The max-and-never-regress semantics are pinned against a real database in
 * tests/db/wc-order-sweep-cursor-commit.test.ts, not here.
 */
export function cursorRaw(
  set: (key: string, value: string) => unknown,
  passthrough: () => Promise<number> = async () => 0,
) {
  return async (strings: TemplateStringsArray, ...values: unknown[]): Promise<number> => {
    if (strings.join('?').includes('INSERT INTO settings')) {
      await set(String(values[0]), String(values[1]))
      return 1
    }
    return passthrough()
  }
}
