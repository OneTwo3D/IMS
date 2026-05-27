export async function withEnvPatch<T>(
  patch: Record<string, string | undefined>,
  run: () => Promise<T> | T,
): Promise<T> {
  // Serial-only helper: these tests mutate process.env and must not run with test concurrency.
  const mutableEnv = process.env as Record<string, string | undefined>
  const previous = Object.fromEntries(
    Object.keys(patch).map((key) => [key, mutableEnv[key]]),
  ) as Record<string, string | undefined>

  try {
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) {
        delete mutableEnv[key]
      } else {
        mutableEnv[key] = value
      }
    }
    return await run()
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete mutableEnv[key]
      } else {
        mutableEnv[key] = value
      }
    }
  }
}
