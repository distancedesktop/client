import type { ClientMessage, ControlMessage } from './types'

export interface ConnectOptions {
  url: string
  // SHA-256 fingerprints (hex) to pin. Empty means the agent serves a trusted
  // certificate (--cert/--key, or a reverse proxy in front) and the browser
  // validates it normally.
  fingerprints: string[]
}

export interface TransportStats {
  bitrate: number
  rtt: number
  rxBytes: number
}

// Advertised for forward compatibility only: the agent's upgrader treats
// ApplicationProtocols as an allow-list, and omitting the wt-protocol header
// negotiates fine (which is what the agent's own viewer does). Sending it costs
// nothing and keeps us working if the agent ever starts requiring a protocol.
const WT_PROTOCOLS = ['moq-lite-04']

type MessageHandler = (msg: ControlMessage) => void
type VideoHandler = (chunk: Uint8Array) => void
type StatsHandler = (stats: TransportStats) => void

export class Transport {
  private wt: WebTransport | null = null
  private ctrlWriter: WritableStreamDefaultWriter<Uint8Array> | null = null
  private ctrlReader: ReadableStreamDefaultReader<Uint8Array> | null = null
  private msgHandler: MessageHandler | null = null
  private videoHandler: VideoHandler | null = null
  private statsHandler: StatsHandler | null = null

  private ctrlBuf: Uint8Array<ArrayBufferLike> = new Uint8Array(0)
  private enc = new TextEncoder()
  private dec = new TextDecoder()

  private rxBytes = 0
  private windowBytes = 0
  private lastWindow = performance.now()
  private bitrate = 0

  private pendingSince = 0
  private rtt = 0

  private statsTimer: number | undefined
  private closed = false

  onMessage(h: MessageHandler) {
    this.msgHandler = h
  }
  setVideoHandler(h: VideoHandler) {
    this.videoHandler = h
  }
  onStats(h: StatsHandler) {
    this.statsHandler = h
  }

  get connected(): boolean {
    return this.wt !== null
  }

  async connect(opts: ConnectOptions): Promise<void> {
    this.closed = false
    const wt = new WebTransport(opts.url, buildOptions(opts.fingerprints))
    this.wt = wt

    // `closed` can settle long after a reconnect has already replaced this.wt.
    // Notifying then would tear down the *new* transport, so a stale callback
    // must stay silent -- the shared `closed` flag alone does not distinguish
    // which transport is reporting.
    const notifyIfCurrent = () => {
      if (this.closed || this.wt !== wt) return
      this.msgHandler?.({ type: 'stream-ended' })
    }
    wt.closed.then(notifyIfCurrent, notifyIfCurrent)

    await wt.ready

    const bidi = await wt.createBidirectionalStream()
    this.ctrlWriter = bidi.writable.getWriter()
    this.ctrlReader = bidi.readable.getReader()
    this.readControlLoop()

    this.readVideoLoop()

    this.statsTimer = window.setInterval(() => this.tickStats(), 1000)
  }

  send(msg: ClientMessage): void {
    if (!this.ctrlWriter) throw new Error('not connected')
    if (msg.type === 'list-displays' || msg.type === 'start') {
      this.pendingSince = performance.now()
    }
    const bytes = this.enc.encode(JSON.stringify(msg) + '\n')
    this.ctrlWriter.write(bytes).catch(() => {
      if (!this.closed) this.msgHandler?.({ type: 'stream-ended' })
    })
  }

  listDisplays(): void {
    this.send({ type: 'list-displays' })
  }

  start(displayId: number, opts: { fps?: number; codec?: string; bitrate?: number } = {}): void {
    this.send({ type: 'start', display_id: displayId, ...opts })
  }

  stop(): void {
    this.send({ type: 'stop' })
  }

  getStats(): TransportStats {
    return { bitrate: this.bitrate, rtt: this.rtt, rxBytes: this.rxBytes }
  }

  close(): void {
    this.closed = true
    if (this.statsTimer) window.clearInterval(this.statsTimer)
    this.statsTimer = undefined
    try { this.ctrlWriter?.close() } catch { /* ignore */ }
    try { this.wt?.close() } catch { /* ignore */ }
    this.wt = null
    this.ctrlWriter = null
    this.ctrlReader = null
    this.ctrlBuf = new Uint8Array(0)
    this.rxBytes = 0
    this.windowBytes = 0
    this.bitrate = 0
    this.rtt = 0
    this.pendingSince = 0
  }

  private async readControlLoop(): Promise<void> {
    const reader = this.ctrlReader
    if (!reader) return
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        if (!value) continue
        this.ctrlBuf = concat(this.ctrlBuf, value)
        let nl: number
        while ((nl = findNL(this.ctrlBuf)) !== -1) {
          const line = this.dec.decode(this.ctrlBuf.subarray(0, nl))
          this.ctrlBuf = this.ctrlBuf.subarray(nl + 1)
          const text = line.trim()
          if (!text) continue
          let msg: ControlMessage
          try { msg = JSON.parse(text) } catch { continue }
          if ((msg.type === 'displays' || msg.type === 'started') && this.pendingSince) {
            this.rtt = Math.round(performance.now() - this.pendingSince)
            this.pendingSince = 0
          }
          this.msgHandler?.(msg)
        }
      }
    } catch { /* stream closed */ }
  }

  private async readVideoLoop(): Promise<void> {
    const wt = this.wt
    if (!wt) return
    try {
      const streamReader = wt.incomingUnidirectionalStreams.getReader()
      while (true) {
        const { value: recv, done: sdone } = await streamReader.read()
        if (sdone) break
        if (!recv) continue
        const reader = recv.readable.getReader()
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          if (!value) continue
          this.rxBytes += value.byteLength
          this.windowBytes += value.byteLength
          this.videoHandler?.(value)
        }
      }
    } catch { /* stream closed */ }
  }

  private tickStats(): void {
    const now = performance.now()
    const dt = (now - this.lastWindow) / 1000
    if (dt > 0) {
      this.bitrate = Math.round((this.windowBytes * 8) / dt)
      this.windowBytes = 0
      this.lastWindow = now
    }
    this.statsHandler?.(this.getStats())
  }
}

// serverCertificateHashes / protocols are missing from some lib.dom releases,
// so the option bag is assembled and cast once here.
function buildOptions(fingerprints: string[]): WebTransportOptions {
  const opts: Record<string, unknown> = { protocols: WT_PROTOCOLS }
  if (fingerprints.length > 0) {
    opts.serverCertificateHashes = fingerprints.map(fp => ({
      algorithm: 'sha-256',
      value: parseFingerprint(fp)
    }))
  }
  return opts as WebTransportOptions
}

// Parse a SHA-256 fingerprint, tolerating colon/space separators.
export function parseFingerprint(hex: string): Uint8Array {
  const bytes = hexToBytes(hex)
  if (bytes.length !== 32) {
    throw new Error('fingerprint must be a 32-byte SHA-256 hex string')
  }
  return bytes
}

export function isValidFingerprint(hex: string): boolean {
  try {
    parseFingerprint(hex)
    return true
  } catch {
    return false
  }
}

// Normalized lowercase hex, so dedupe survives formatting differences.
export function normalizeFingerprint(hex: string): string {
  return hex.replace(/[^0-9a-fA-F]/g, '').toLowerCase()
}

function concat(a: Uint8Array<ArrayBufferLike>, b: Uint8Array<ArrayBufferLike>): Uint8Array<ArrayBufferLike> {
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

function findNL(buf: Uint8Array): number {
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) return i
  }
  return -1
}

function hexToBytes(hex: string): Uint8Array {
  const clean = normalizeFingerprint(hex)
  if (clean.length % 2 !== 0) throw new Error('invalid hex length')
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16)
  }
  return out
}

export function wtUrl(host: string, port: number): string {
  const h = host.replace(/^https?:\/\//, '').replace(/\/$/, '')
  return `https://${h}:${port}/wt`
}
