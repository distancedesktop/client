import type { ConnectionConfig } from '../types'
import { el } from '../util'
import { isValidFingerprint, normalizeFingerprint } from '../transport'

const STORAGE_KEY = 'distance-connections'

// How many rotated fingerprints to keep per connection. The agent rotates when
// fewer than 7 days remain on a 14-day cert, so a handful covers any realistic
// gap between client sessions.
const MAX_FINGERPRINTS = 4

export function loadConnections(): ConnectionConfig[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

export function saveConnections(conns: ConnectionConfig[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(conns))
}

export interface AppendResult {
  changed: boolean
  fingerprints: string[]
}

/**
 * Append a fingerprint to a stored connection, newest first, deduped and capped.
 * Used for the connect-time push and for mid-stream rotation broadcasts.
 */
export function appendFingerprint(id: string, fingerprint: string): AppendResult {
  const normalized = normalizeFingerprint(fingerprint)
  const conns = loadConnections()
  const conn = conns.find(c => c.id === id)
  if (!conn) return { changed: false, fingerprints: [] }

  const existing = (conn.fingerprints ?? []).map(normalizeFingerprint).filter(fp => fp.length > 0)
  if (existing[0] === normalized) return { changed: false, fingerprints: existing }

  const next = [normalized, ...existing.filter(fp => fp !== normalized)].slice(0, MAX_FINGERPRINTS)
  conn.fingerprints = next
  saveConnections(conns)
  return { changed: true, fingerprints: next }
}

export interface SidebarCallbacks {
  onSelect: (config: ConnectionConfig) => void
  onDelete: (id: string) => void
  onAdd: (config: ConnectionConfig) => void
}

const STATUS_LABELS: Record<string, string> = {
  connecting: 'Connecting\u2026',
  reconnecting: 'Reconnecting\u2026',
  connected: 'Connected',
  streaming: 'Streaming'
}

export class Sidebar {
  private root: HTMLElement
  private cbs: SidebarCallbacks
  private connections: ConnectionConfig[]
  private statuses: Record<string, string> = {}
  private showingForm = false

  constructor(root: HTMLElement, cbs: SidebarCallbacks) {
    this.root = root
    this.cbs = cbs
    this.connections = loadConnections()
  }

  updateStatus(id: string, status: string): void {
    this.statuses[id] = status
    this.render()
  }

  setConnections(conns: ConnectionConfig[]): void {
    this.connections = conns
    saveConnections(conns)
    this.render()
  }

  // Re-read from storage without clobbering it, for changes made elsewhere
  // (a cached fingerprint push, for instance).
  reload(): void {
    this.connections = loadConnections()
    this.render()
  }

  render(): void {
    this.root.innerHTML = ''

    const header = el('div', { class: 'sidebar-header' }, [
      el('h1', { text: 'Distance Client' }),
      el('p', { class: 'subtle', text: 'Remote Desktop Viewer' })
    ])
    this.root.append(header)

    if (this.showingForm) {
      this.renderForm()
    } else {
      const addBtn = el('button', { class: 'add-btn', text: '+ Add Connection' }) as HTMLButtonElement
      addBtn.addEventListener('click', () => {
        this.showingForm = true
        this.render()
      })
      this.root.append(addBtn)
    }

    if (this.connections.length === 0) {
      this.root.append(el('div', { class: 'empty-state', text: 'No connections yet' }))
    } else {
      const list = el('ul', { class: 'connection-list' })
      for (const conn of this.connections) {
        const status = this.statuses[conn.id]
        const item = el('li', { class: 'connection-item' })
        if (status === 'connecting' || status === 'reconnecting') item.classList.add('connecting')

        const main = el('button', { class: 'connection-main' })
        main.append(
          el('span', { class: 'conn-name', text: conn.name }),
          el('span', { class: 'conn-host', text: `${conn.host}:${conn.port}` })
        )
        if (conn.trustedCert) {
          main.append(el('span', { class: 'conn-tag', text: 'trusted cert' }))
        } else if (conn.fingerprints.length > 1) {
          main.append(el('span', { class: 'conn-tag', text: `${conn.fingerprints.length} fingerprints` }))
        }
        if (status && status !== 'disconnected') {
          const badge = el('span', { class: 'conn-status' })
          badge.setAttribute('data-status', status)
          badge.textContent = STATUS_LABELS[status] ?? status
          main.append(badge)
        }
        main.addEventListener('click', () => this.cbs.onSelect(conn))

        const del = el('button', { class: 'conn-delete', text: '\u00d7' }) as HTMLButtonElement
        del.title = 'Remove connection'
        del.addEventListener('click', (e) => {
          e.stopPropagation()
          this.cbs.onDelete(conn.id)
        })

        item.append(main, del)
        list.append(item)
      }
      this.root.append(list)
    }
  }

  private renderForm(): void {
    const form = el('form', { class: 'add-connection' })
    const nameInput = el('input', { type: 'text', placeholder: 'Name (e.g. Home PC)' }) as HTMLInputElement
    const hostInput = el('input', { type: 'text', placeholder: 'Host (IP or hostname)' }) as HTMLInputElement
    const portInput = el('input', { type: 'number', placeholder: 'Port' }) as HTMLInputElement
    portInput.value = '52020'

    const fpRow = el('div', { class: 'form-row' })
    const fpInput = el('input', { type: 'text', placeholder: 'SHA-256 Fingerprint (64 hex chars)' }) as HTMLInputElement
    fpRow.append(fpInput)

    // Agents started with --cert/--key (or fronted by a reverse proxy) serve a
    // certificate the browser already trusts. There is no cert manager in that
    // mode, so there is no fingerprint to pin and none gets pushed.
    const trustedRow = el('label', { class: 'form-check' })
    const trustedBox = el('input', { type: 'checkbox' }) as HTMLInputElement
    trustedRow.append(
      trustedBox,
      el('span', { text: 'Trusted certificate / behind reverse proxy' })
    )
    const trustedHint = el('p', {
      class: 'form-hint hidden',
      text: 'No fingerprint pinning \u2014 the browser validates the certificate itself.'
    })
    trustedBox.addEventListener('change', () => {
      fpRow.classList.toggle('hidden', trustedBox.checked)
      trustedHint.classList.toggle('hidden', !trustedBox.checked)
      if (trustedBox.checked) fpInput.value = ''
    })

    const actions = el('div', { class: 'add-actions' })
    const saveBtn = el('button', { type: 'submit', text: 'Save' }) as HTMLButtonElement
    const cancelBtn = el('button', { type: 'button', text: 'Cancel' }) as HTMLButtonElement
    cancelBtn.addEventListener('click', () => {
      this.showingForm = false
      this.render()
    })
    actions.append(saveBtn, cancelBtn)

    form.append(nameInput, hostInput, portInput, trustedRow, trustedHint, fpRow, actions)
    form.addEventListener('submit', (e) => {
      e.preventDefault()
      const name = nameInput.value.trim()
      const host = hostInput.value.trim()
      const port = parseInt(portInput.value, 10) || 52020
      const trustedCert = trustedBox.checked
      const fp = normalizeFingerprint(fpInput.value)
      if (!name || !host) return
      if (!trustedCert && fp && !isValidFingerprint(fp)) {
        fpInput.setCustomValidity('Expected 64 hex characters (SHA-256)')
        fpInput.reportValidity()
        return
      }
      fpInput.setCustomValidity('')
      const config: ConnectionConfig = {
        id: crypto.randomUUID(),
        name,
        host,
        port,
        fingerprints: !trustedCert && fp ? [fp] : [],
        trustedCert
      }
      this.cbs.onAdd(config)
      this.showingForm = false
      this.reload()
    })

    this.root.append(form)
    nameInput.focus()
  }
}
