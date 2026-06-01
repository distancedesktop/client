import { extractAvcDescription, codecString, type AvcDescription } from './nal-parser'

export type DecoderEvent =
  | { type: 'frame'; frame: VideoFrame }
  | { type: 'error'; message: string }
  | { type: 'config' }

export class VideoDecoderClient {
  private decoder: VideoDecoder | null = null
  private avcDesc: AvcDescription | null = null
  private configured = false
  private pendingData: ArrayBuffer[] = []
  private onEvent: (event: DecoderEvent) => void
  private totalFrames = 0
  private destroyed = false

  constructor(onEvent: (event: DecoderEvent) => void) {
    this.onEvent = onEvent
  }

  feed(data: ArrayBuffer): void {
    if (this.destroyed) return

    const u8 = new Uint8Array(data)

    if (!this.configured) {
      if (!this.avcDesc) {
        const desc = extractAvcDescription(u8)
        if (desc) {
          this.avcDesc = desc
          this.pendingData.push(data)
          this.tryConfigure()
          return
        }
      }
      this.pendingData.push(data)
      return
    }

    this.decodeChunk(data)
  }

  private tryConfigure(): void {
    if (this.destroyed || !this.avcDesc) return

    const codec = codecString(this.avcDesc.profile, this.avcDesc.constraints, this.avcDesc.level)

    if (!('VideoDecoder' in window)) {
      this.onEvent({ type: 'error', message: 'WebCodecs not supported in this browser' })
      return
    }

    this.decoder = new VideoDecoder({
      output: (frame: VideoFrame) => {
        if (this.destroyed) { frame.close(); return }
        this.totalFrames++
        this.onEvent({ type: 'frame', frame })
      },
      error: (err: Error) => {
        if (this.destroyed) return
        this.onEvent({ type: 'error', message: `Decoder error: ${err.message}` })
      },
    })

    const config: VideoDecoderConfig = {
      codec,
      description: this.avcDesc.extradata,
      optimizeForLatency: true,
    }

    this.decoder.configure(config)
    this.configured = true
    this.onEvent({ type: 'config' })

    for (const pending of this.pendingData) {
      this.decodeChunk(pending)
    }
    this.pendingData = []
  }

  private decodeChunk(data: ArrayBuffer): void {
    if (this.destroyed || !this.decoder || this.decoder.state === 'closed') return

    const chunk = new EncodedVideoChunk({
      type: this.detectChunkType(data),
      timestamp: this.totalFrames * 1_000_000,
      duration: 16_667,
      data,
    })

    this.decoder.decode(chunk)
  }

  private detectChunkType(data: ArrayBuffer): EncodedVideoChunkType {
    const u8 = new Uint8Array(data)
    for (let i = 0; i < u8.length - 4; i++) {
      if (u8[i] === 0 && u8[i + 1] === 0 && u8[i + 2] === 0 && u8[i + 3] === 1) {
        const nalType = u8[i + 4] & 0x1f
        if (nalType === 5) return 'key'
      } else if (u8[i] === 0 && u8[i + 1] === 0 && u8[i + 2] === 1) {
        const nalType = u8[i + 3] & 0x1f
        if (nalType === 5) return 'key'
      }
    }
    return 'delta'
  }

  close(): void {
    this.destroyed = true
    if (this.decoder) {
      this.decoder.close()
      this.decoder = null
    }
    this.configured = false
    this.avcDesc = null
    this.pendingData = []
    this.totalFrames = 0
  }

  flush(): void {
    this.decoder?.flush()
  }
}
