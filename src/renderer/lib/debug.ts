const logs: string[] = []
const MAX_LOGS = 100
const listeners: Array<() => void> = []

export function debugLog(...args: unknown[]): void {
  const ts = new Date().toISOString().slice(11, 23)
  const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')
  const entry = `[${ts}] ${msg}`
  console.debug('[Distance]', ...args)
  logs.push(entry)
  if (logs.length > MAX_LOGS) logs.shift()
  listeners.forEach(fn => fn())
}

export function getDebugLogs(): string[] {
  return [...logs]
}

export function onDebugLogUpdate(fn: () => void): () => void {
  listeners.push(fn)
  return () => {
    const idx = listeners.indexOf(fn)
    if (idx >= 0) listeners.splice(idx, 1)
  }
}
