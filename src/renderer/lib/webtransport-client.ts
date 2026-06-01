import type { ConnectionConfig, ServerMessage, ClientMessage, DisplayInfo } from './types'
import { debugLog } from './debug'

export type StreamEvent =
  | { type: 'displays'; displays: DisplayInfo[] }
  | { type: 'started'; width: number; height: number; codec: string }
  | { type: 'stopped' }
  | { type: 'error'; message: string }
  | { type: 'stream-ended' }
  | { type: 'disconnected' }
  | { type: 'connecting' }
  | { type: 'connected' }
  | { type: 'fingerprint-refresh'; algorithm: string; fingerprint: string }

function parseFingerprint(hex: string): Uint8Array {
  const clean = hex.replace(/[^0-9a-fA-F]/g, '')
  const bytes = new Uint8Array(clean.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

export class WebTransportClient {
  private transport: WebTransport | null = null
  private config: ConnectionConfig
  private onEvent: (event: StreamEvent) => void
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null
  private aborted = false
  private abortController: AbortController | null = null

  constructor(config: ConnectionConfig, onEvent: (event: StreamEvent) => void) {
    this.config = config
    this.onEvent = onEvent
  }

  getTransport(): WebTransport | null {
    return this.transport
  }

  getUrl(): string {
    return `https://${this.config.host}:${this.config.port}/wt`
  }

  connect(): void {
    this.aborted = false
    this.abortController = new AbortController()
    debugLog(`connect() called for ${this.config.host}:${this.config.port}`)
    this.onEvent({ type: 'connecting' })
    this.start().catch((err) => {
      if (this.aborted) return
      const msg = `Connection failed: ${err instanceof Error ? err.message : String(err)}`
      debugLog('connect() failed:', msg)
      this.onEvent({ type: 'error', message: msg })
      this.onEvent({ type: 'disconnected' })
    })
  }

  private async start(): Promise<void> {
    const url = this.getUrl()
    debugLog(`start(): connecting to ${url}`)
    debugLog(`start(): fingerprints:`, this.config.fingerprints)

    const options: WebTransportOptions = {
      protocols: ['moq-lite-04', 'moq-lite-03', 'moql', 'moqt-18', 'moqt-17', 'moqt-16', 'moqt-15'],
    }
    if (this.config.fingerprints && this.config.fingerprints.length > 0) {
      options.serverCertificateHashes = this.config.fingerprints.map((fp) => ({
        algorithm: 'sha-256',
        value: parseFingerprint(fp) as BufferSource,
      }))
      debugLog(`start(): using ${this.config.fingerprints.length} cert fingerprint(s)`)
    }

    this.transport = new WebTransport(url, options)
    debugLog('start(): WebTransport instance created, waiting for ready...')

    this.transport.closed.then(() => {
      debugLog('transport.closed resolved (clean close)')
      if (!this.aborted) {
        this.onEvent({ type: 'disconnected' })
      }
    }).catch((err) => {
      debugLog('transport.closed rejected:', err)
      if (!this.aborted) {
        this.onEvent({ type: 'disconnected' })
      }
    })

    try {
      await this.transport.ready
      debugLog('start(): transport.ready resolved - WebTransport connected!')
    } catch (err) {
      debugLog('start(): transport.ready REJECTED:', err)
      throw err
    }
    if (this.aborted) return

    debugLog('start(): creating bidirectional stream...')
    const bidiStream = await this.transport.createBidirectionalStream()
    debugLog('start(): bidirectional stream created')
    if (this.aborted) return
    this.writer = bidiStream.writable.getWriter()

    this.onEvent({ type: 'connected' })

    const signal = this.abortController!.signal
    this.readControlStream(bidiStream.readable, signal)
  }

  private async readControlStream(
    readable: ReadableStream,
    signal: AbortSignal,
  ): Promise<void> {
    const reader = readable.getReader()
    const decoder = new TextDecoder()

    try {
      while (true) {
        if (signal.aborted) {
          debugLog('readControlStream: signal aborted, exiting')
          break
        }
        const { value, done } = await reader.read()
        if (done) {
          debugLog('readControlStream: stream done (closed by server)')
          break
        }

        let text: string
        try {
          text = decoder.decode(value as BufferSource, { stream: true })
        } catch (e) {
          debugLog('readControlStream: decode error:', e)
          continue
        }

        debugLog('readControlStream: raw data received:', text)
        const lines = text.split('\n').filter(Boolean)
        for (const line of lines) {
          try {
            const parsed = JSON.parse(line) as ServerMessage
            debugLog('readControlStream: parsed message:', parsed)
            this.handleControlMessage(parsed)
          } catch (e) {
            debugLog('readControlStream: invalid JSON:', line, e)
            this.onEvent({ type: 'error', message: 'Invalid JSON from server' })
          }
        }
      }
    } catch (err) {
      debugLog('readControlStream: error:', err)
      if (!this.aborted && !signal.aborted) {
        this.onEvent({ type: 'error', message: `Control stream error: ${err instanceof Error ? err.message : String(err)}` })
      }
    }
  }

  private handleControlMessage(msg: ServerMessage): void {
    debugLog('handleControlMessage:', msg.type, msg)
    switch (msg.type) {
      case 'displays':
        this.onEvent({ type: 'displays', displays: msg.displays })
        break
      case 'started':
        this.onEvent({ type: 'started', width: msg.width, height: msg.height, codec: msg.codec })
        break
      case 'stopped':
        this.onEvent({ type: 'stopped' })
        break
      case 'error':
        debugLog('server error:', msg.message)
        this.onEvent({ type: 'error', message: msg.message })
        break
      case 'stream-ended':
        this.onEvent({ type: 'stream-ended' })
        break
      case 'fingerprint-refresh':
        debugLog('fingerprint refresh:', msg.algorithm, msg.fingerprint)
        this.onEvent({
          type: 'fingerprint-refresh',
          algorithm: msg.algorithm,
          fingerprint: msg.fingerprint,
        })
        break
      default:
        debugLog('unhandled message type:', (msg as { type: string }).type)
    }
  }

  private async send(msg: ClientMessage): Promise<void> {
    if (!this.writer) {
      debugLog('send(): no writer, dropping message:', msg.type)
      return
    }
    try {
      const encoder = new TextEncoder()
      const data = encoder.encode(JSON.stringify(msg) + '\n')
      debugLog('send():', JSON.stringify(msg))
      await this.writer.write(data)
    } catch (e) {
      debugLog('send(): error:', e)
    }
  }

  listDisplays(): void {
    debugLog('listDisplays() called')
    this.send({ type: 'list-displays' })
  }

  startStream(displayId: number, fps = 60, codec = 'h264', bitrate?: number): void {
    debugLog(`startStream(): display=${displayId} fps=${fps} codec=${codec} bitrate=${bitrate}`)
    this.send({ type: 'start', display_id: displayId, fps, codec, bitrate })
  }

  stopStream(): void {
    debugLog('stopStream() called')
    this.send({ type: 'stop' })
  }

  disconnect(): void {
    debugLog('disconnect() called')
    this.aborted = true
    this.writer = null
    if (this.transport) {
      this.transport.close()
      this.transport = null
    }
  }
}
