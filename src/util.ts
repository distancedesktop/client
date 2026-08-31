export function $(sel: string, root: ParentNode = document): HTMLElement {
  const el = root.querySelector(sel)
  if (!el) throw new Error(`missing element: ${sel}`)
  return el as HTMLElement
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Partial<Record<string, string>> = {},
  children: (Node | string)[] = []
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined) continue
    if (k === 'class') node.className = v
    else if (k === 'text') node.textContent = v
    else node.setAttribute(k, v)
  }
  for (const c of children) node.append(c)
  return node
}

export function formatBitrate(bps: number): string {
  if (bps < 1000) return `${bps.toFixed(0)} bps`
  if (bps < 1_000_000) return `${(bps / 1000).toFixed(0)} kbps`
  return `${(bps / 1_000_000).toFixed(2)} Mbps`
}

let toastTimer: number | undefined
export function toast(msg: string, kind: 'info' | 'err' | 'ok' = 'info', ms = 3200): void {
  const t = document.getElementById('toast')
  if (!t) return
  t.textContent = msg
  t.className = `toast ${kind === 'info' ? '' : kind}`
  if (toastTimer) window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => t.classList.add('hidden'), ms)
}

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
