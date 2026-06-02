import * as Moq from '@moq/net'
import * as Watch from '@moq/watch'
import { Signal } from '@moq/signals'
import { debugLog } from './debug'

function parseFingerprint(hex: string): Uint8Array {
  const clean = hex.replace(/[^0-9a-fA-F]/g, '')
  const bytes = new Uint8Array(clean.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

export class MoqIntegration {
  private established: Moq.Connection.Established | null = null
  private broadcast: Watch.Broadcast | null = null
  private backend: Watch.MultiBackend | null = null
  private establishedSig: Signal<Moq.Connection.Established | undefined> | null = null
  private _connected = false

  get connected(): boolean {
    return this._connected
  }

  async connect(host: string, port: number, fingerprints: string[]): Promise<void> {
    if (this.established) return
    debugLog('MoqIntegration: connecting MoQ layer to /moq...')
    try {
      const url = `https://${host}:${port}/moq`
      const wt = new WebTransport(url, {
        protocols: ['moq-lite-04', 'moq-lite-03', 'moql', 'moqt-18', 'moqt-17', 'moqt-16', 'moqt-15'],
        serverCertificateHashes: fingerprints.map(fp => ({
          algorithm: 'sha-256',
          value: parseFingerprint(fp) as BufferSource,
        })),
      })
      await wt.ready
      const parsedUrl = new URL(url)
      this.established = await Moq.Connection.connect(parsedUrl, { transport: wt })
      this.establishedSig = new Signal(this.established)
      this._connected = true
      debugLog('MoqIntegration: MoQ connected, version:', this.established.version)
    } catch (err) {
      debugLog('MoqIntegration: MoQ connect failed:', err)
      this._connected = false
      throw err
    }
  }

  startDisplay(canvas: HTMLCanvasElement, displayId: number): void {
    if (!this.established || !this.establishedSig) {
      debugLog('MoqIntegration: cannot start display, MoQ not connected')
      return
    }

    const path = Moq.Path.from('display', String(displayId))
    debugLog('MoqIntegration: subscribing to broadcast:', path)

    this.broadcast = new Watch.Broadcast({
      connection: this.establishedSig,
      name: path,
      enabled: true,
    })

    this.backend = new Watch.MultiBackend({
      element: canvas,
      broadcast: this.broadcast,
    })

    debugLog('MoqIntegration: display started')
  }

  stopDisplay(): void {
    debugLog('MoqIntegration: stopping display')
    if (this.backend) {
      this.backend.close()
      this.backend = null
    }
    if (this.broadcast) {
      this.broadcast.close()
      this.broadcast = null
    }
    debugLog('MoqIntegration: display stopped')
  }

  close(): void {
    debugLog('MoqIntegration: closing')
    this.stopDisplay()
    if (this.established) {
      this.established.close()
      this.established = null
      this.establishedSig = null
      this._connected = false
    }
    debugLog('MoqIntegration: closed')
  }
}
