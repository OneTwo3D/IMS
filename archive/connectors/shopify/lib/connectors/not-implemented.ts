export function notImplementedResult(feature: string, connector: string) {
  return {
    success: false,
    error: `${connector} ${feature} is not implemented yet`,
  }
}

export function notImplementedError(feature: string, connector: string): never {
  throw new Error(`${connector} ${feature} is not implemented yet`)
}
