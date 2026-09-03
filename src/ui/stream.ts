import type { ConnectionConfig, DisplayInfo, ControlMessage } from '../types'
import { Transport, wtUrl, isValidFingerprint } from '../transport'
import { Decoder } from '../decoder'
import { InputController } from '../input'
import { el, debugLog, toast } from '../util'
import { StatsOverlay } from './stats'
import { appendFingerprint } from './sidebar'

// Frame rate requested from the agent. Also used as the decoder's timestamp
// base, so the two must agree or presentation timestamps drift from real time.
const REQUESTED_FPS = 60

// Reconnect backoff: exponential with full jitter, capped.
const RECONNECT_BASE_MS = 500
const RECONNECT_CAP_MS = 15_000
const RECONNECT_MAX_ATTEMPTS = 8

export interface StreamPanelCallbacks {
  onStatusChange: (status: string) => void
  onError: (message: string) => void
  onBack: () => void
  // Fired when the stored connection changed (e.g. a rotated fingerprint was
  // cached) so the sidebar can pick the new value up.
  onConfigChange: () => void
}

export class StreamPanel {
  private root: HTMLElement
  private config: ConnectionConfig
  private transport: Transport
  private decoder: Decoder
  private stats: StatsOverlay
  private input: InputController
  private canvas: HTMLCanvasElement

  private displays: DisplayInfo[] = []
  private selectedDisplayId = 0
  private streaming = false
  private inputEnabled = false

  private attempt = 0
  private reconnectTimer: number | undefined
  private connecting = false
  private destroyed = false

  private cbs: StreamPanelCallbacks

  constructor(root: HTMLElement, config: ConnectionConfig, cbs: StreamPanelCallbacks) {
    this.root = root
    this.config = config
    this.cbs = cbs

    this.transport = new Transport()
    this.canvas = el('canvas') as HTMLCanvasElement
    this.decoder = new Decoder(this.canvas)
    this.stats = new StatsOverlay()
    this.input = new InputController((msg) => {
      if (this.inputEnabled) this.transport.send(msg)
    })

    this.transport.onMessage((msg: ControlMessage) => this.handleMessage(msg))
    this.transport.setVideoHandler((chunk) => this.decoder.feed(chunk))
    this.transport.onStats((s) => {
      this.stats.update({ bitrate: s.bitrate, rtt: s.rtt, online: this.transport.connected })
    })
    this.decoder.onFps = (fps) => this.stats.update({ fps })
    this.decoder.onFirstFrame = () => this.stats.show()

    this.render()
    void this.connect()
  }

  private render(): void {
    this.root.innerHTML = ''

    const header = el('div', { class: 'stream-header' })
    const backBtn = el('button', { class: 'back-btn', text: '\u2190 Back' }) as HTMLButtonElement
    backBtn.addEventListener('click', () => this.cbs.onBack())
    header.append(
      backBtn,
      el('h1', { text: this.config.name }),
      el('span', { class: 'header-host', text: `${this.config.host}:${this.config.port}` })
    )
    this.root.append(header)

    const toolbar = el('div', { class: 'display-selector' })
    toolbar.id = 'stream-toolbar'
    this.root.append(toolbar)

    const container = el('div', { class: 'canvas-container' })
    container.append(this.canvas)
    this.root.append(container)

    this.root.append(this.stats.el)
  }

  private updateToolbar(): void {
    const toolbar = this.root.querySelector('#stream-toolbar')
    if (!toolbar) return
    toolbar.innerHTML = ''

    if (this.streaming) {
      const info = el('span', { text: `Streaming (${this.decoder.currentFps} fps)` })
      const stopBtn = el('button', { class: 'stop-btn', text: 'Stop' }) as HTMLButtonElement
      stopBtn.addEventListener('click', () => this.stopStream())
      toolbar.append(info, this.inputToggle(), stopBtn)
      return
    }

    if (this.displays.length > 0) {
      const label = el('label', { text: 'Select display to stream:' })
      const select = el('select') as HTMLSelectElement
      for (const d of this.displays) {
        const opt = el('option', {
          value: String(d.id),
          text: `Display ${d.id} \u2014 ${d.width}x${d.height}${d.refresh_rate ? ` @ ${Math.round(d.refresh_rate)}Hz` : ''}`
        }) as HTMLOptionElement
        if (d.id === this.selectedDisplayId) opt.selected = true
        select.append(opt)
      }
      select.addEventListener('change', () => {
        this.selectedDisplayId = Number(select.value)
      })
      const startBtn = el('button', { class: 'start-btn', text: 'Start Stream' }) as HTMLButtonElement
      startBtn.addEventListener('click', () => this.startStream())
      toolbar.append(label, select, startBtn)
    }
  }

  // Remote input is off by default: the agent has no `input` handler yet, so
  // enabling it only produces `unknown type: input` errors until it does.
  private inputToggle(): HTMLElement {
    const wrap = el('label', { class: 'input-toggle' })
    const box = el('input', { type: 'checkbox' }) as HTMLInputElement
    box.checked = this.inputEnabled
    box.addEventListener('change', () => this.setInputEnabled(box.checked))
    wrap.title = 'Experimental: the agent does not implement an input handler yet'
    wrap.append(box, el('span', { text: 'Send input (experimental)' }))
    return wrap
  }

  private setInputEnabled(on: boolean): void {
    this.inputEnabled = on
    if (on) {
      this.input.attach(this.canvas)
      toast('Remote input enabled \u2014 click the canvas to capture pointer', 'info')
    } else {
      this.input.detach()
    }
    this.updateToolbar()
  }

  private async connect(): Promise<void> {
    if (this.destroyed || this.connecting || this.reconnectTimer !== undefined) return
    this.connecting = true
    this.cbs.onStatusChange(this.attempt > 0 ? 'reconnecting' : 'connecting')

    const fingerprints = this.activeFingerprints()
    if (fingerprints.length === 0 && !this.config.trustedCert) {
      this.connecting = false
      this.cbs.onError('No fingerprint configured, and this connection is not marked as using a trusted certificate')
      this.cbs.onStatusChange('disconnected')
      return
    }

    const url = wtUrl(this.config.host, this.config.port)
    debugLog('Connecting to', url, fingerprints.length ? `(${fingerprints.length} pinned fingerprint(s))` : '(trusted certificate)')
    try {
      await this.transport.connect({ url, fingerprints })
      this.connecting = false
      if (this.destroyed) {
        this.transport.close()
        return
      }
      this.attempt = 0
      this.cbs.onStatusChange('connected')
      // The agent pushes `displays` unprompted right after connecting; this
      // request is a fallback for agents that do not (or when the push failed).
      this.transport.listDisplays()
    } catch (e) {
      this.connecting = false
      const msg = `Connection failed: ${(e as Error).message}`
      debugLog(msg)
      this.scheduleReconnect(msg)
    }
  }

  // Pinned hashes for this connection. Empty means "let the browser validate
  // the certificate normally" — the agent run with --cert/--key, or behind a
  // reverse proxy, has no cert manager and no fingerprint to pin.
  private activeFingerprints(): string[] {
    if (this.config.trustedCert) return []
    return this.config.fingerprints.filter(isValidFingerprint)
  }

  // Idempotent: `wt.closed` rejecting and the failed `connect()` await both
  // report the same drop, so only the first one gets to arm a timer.
  private scheduleReconnect(reason: string): void {
    if (this.destroyed || this.connecting || this.reconnectTimer !== undefined) return
    this.transport.close()
    this.decoder.reset()
    if (this.streaming) {
      this.streaming = false
      this.setInputEnabled(false)
    }
    this.displays = []
    this.updateToolbar()

    if (this.attempt >= RECONNECT_MAX_ATTEMPTS) {
      debugLog('Giving up after', this.attempt, 'reconnect attempts')
      this.cbs.onError(`${reason} \u2014 gave up after ${this.attempt} reconnect attempts`)
      this.cbs.onStatusChange('disconnected')
      toast('Connection lost \u2014 reconnect attempts exhausted', 'err')
      return
    }

    // Exponential backoff with full jitter.
    const ceiling = Math.min(RECONNECT_CAP_MS, RECONNECT_BASE_MS * 2 ** this.attempt)
    const delay = Math.round(Math.random() * ceiling)
    this.attempt++
    debugLog(`Reconnecting in ${delay}ms (attempt ${this.attempt}/${RECONNECT_MAX_ATTEMPTS})`)
    this.cbs.onStatusChange('reconnecting')
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = undefined
      void this.connect()
    }, delay)
  }

  private handleMessage(msg: ControlMessage): void {
    debugLog('Control message:', msg.type)
    switch (msg.type) {
      case 'displays':
        this.displays = msg.displays
        if (msg.displays.length > 0 && !this.displays.some(d => d.id === this.selectedDisplayId)) {
          this.selectedDisplayId = msg.displays[0].id
        }
        this.updateToolbar()
        break
      case 'started':
        this.streaming = true
        this.decoder.configure(msg.codec, msg.width, msg.height, REQUESTED_FPS)
        this.stats.update({ width: msg.width, height: msg.height })
        this.cbs.onStatusChange('streaming')
        this.updateToolbar()
        toast(`Streaming ${msg.width}\u00d7${msg.height}`, 'ok')
        break
      case 'stopped':
        this.streaming = false
        this.displays = []
        this.decoder.reset()
        this.setInputEnabled(false)
        this.cbs.onStatusChange('connected')
        this.updateToolbar()
        // Ask for displays again so the panel returns to a usable state.
        this.transport.listDisplays()
        break
      case 'stream-ended':
        this.scheduleReconnect('Session ended')
        break
      case 'error':
        this.handleError(msg.message)
        break
      case 'fingerprint-refresh':
        this.cacheFingerprint(msg.fingerprint)
        break
      case 'pong':
        // Server-side `ping` is unimplemented; kept for protocol completeness.
        debugLog('pong', msg.t)
        break
    }
  }

  // The agent answers any message it does not know with
  // `{"type":"error","message":"unknown type: <t>"}`. That is a protocol
  // capability gap, not a session failure, so it must never tear the panel down.
  private handleError(message: string): void {
    const unknown = /^unknown type: /.test(message)
    if (!unknown) {
      this.cbs.onError(message)
      toast(`Agent: ${message}`, 'err')
      return
    }
    debugLog('Agent does not support this message:', message)
    if (message === 'unknown type: input' && this.inputEnabled) {
      // Every forwarded event would bounce back as an error; stop sending.
      this.setInputEnabled(false)
      toast('Agent has no input handler \u2014 remote input disabled', 'info')
    }
  }

  // Cache a rotated fingerprint so the next connect still validates. The agent
  // pushes this unconditionally at connect time, and broadcasts it on rotation
  // to sessions attached to a live stream.
  private cacheFingerprint(fingerprint: string): void {
    if (!isValidFingerprint(fingerprint)) {
      debugLog('Ignoring malformed fingerprint push:', fingerprint)
      return
    }
    const result = appendFingerprint(this.config.id, fingerprint)
    if (!result.changed) return
    this.config.fingerprints = result.fingerprints
    this.cbs.onConfigChange()
    debugLog('Cached agent fingerprint:', fingerprint)
    toast('Agent certificate fingerprint cached', 'ok')
  }

  private startStream(): void {
    this.transport.start(this.selectedDisplayId, { fps: REQUESTED_FPS })
  }

  toggleStats(): void {
    this.stats.toggle()
  }

  private stopStream(): void {
    this.transport.stop()
    this.streaming = false
    this.decoder.reset()
    this.setInputEnabled(false)
    this.updateToolbar()
  }

  destroy(): void {
    this.destroyed = true
    if (this.reconnectTimer) window.clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
    this.input.detach()
    this.transport.close()
    this.decoder.close()
    this.root.innerHTML = ''
  }
}
