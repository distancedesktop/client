/**
 * H264 (Annex B) decoder on the platform WebCodecs `VideoDecoder`, drawing onto
 * a <canvas>.
 *
 * Transport supplies one complete Annex B access unit per framed video record.
 * Split its NALs, derive avcC and the codec string from SPS/PPS, then convert to
 * AVCC for WebCodecs. Keyframe flags and timestamps come from the record header.
 *
 * Streams are always joined mid-GOP, since the agent's encoder is already
 * running when a viewer connects, so access units before the first keyframe are
 * discarded (see `emitAU`).
 */

import type { VideoFrameRecord } from './video'

const NAL_SPS = 7
const NAL_PPS = 8

function nalType(nal: Uint8Array): number {
  return nal[0] & 0x1f
}

/**
 * Build the AVCDecoderConfigurationRecord (avcC) from SPS/PPS NALs.
 * Both are passed without start codes but with their 1-byte NAL header.
 */
function buildAvcC(sps: Uint8Array, pps: Uint8Array): Uint8Array {
  const out = new Uint8Array(5 + 1 + 2 + sps.length + 1 + 2 + pps.length)
  let o = 0
  out[o++] = 1 // configurationVersion
  out[o++] = sps[1] // AVCProfileIndication = profile_idc
  out[o++] = sps[2] // profile_compatibility = constraint flags
  out[o++] = sps[3] // AVCLevelIndication = level_idc
  out[o++] = 0xff // 6 bits reserved + lengthSizeMinusOne = 3 (4-byte lengths)
  out[o++] = 0xe1 // 3 bits reserved + numOfSequenceParameterSets = 1
  out[o++] = (sps.length >> 8) & 0xff
  out[o++] = sps.length & 0xff
  out.set(sps, o)
  o += sps.length
  out[o++] = 1 // numOfPictureParameterSets
  out[o++] = (pps.length >> 8) & 0xff
  out[o++] = pps.length & 0xff
  out.set(pps, o)
  o += pps.length
  return out.subarray(0, o)
}

/** Derive the RFC 6381 codec string (e.g. `avc1.4d4020`) from an SPS NAL. */
function codecStringFromSps(sps: Uint8Array): string | null {
  if (sps.length < 4 || sps.length > 65535 || sps[0] & 0x80 || nalType(sps) !== NAL_SPS || sps[1] === 0 || sps[3] === 0) return null
  const h = (n: number) => n.toString(16).padStart(2, '0')
  return `avc1.${h(sps[1])}${h(sps[2])}${h(sps[3])}`
}

/** Index of the first Annex B start code at or after `from`, else -1. */
function findStartCode(buf: Uint8Array, from: number): number {
  for (let i = from; i + 3 <= buf.length; i++) {
    if (buf[i] === 0x00 && buf[i + 1] === 0x00) {
      if (buf[i + 2] === 0x01) return i
      if (buf[i + 2] === 0x00 && i + 3 < buf.length && buf[i + 3] === 0x01) return i
    }
  }
  return -1
}

/** Length of the start code at index `i` (3 or 4). */
function startCodeLen(buf: Uint8Array, i: number): number {
  return i + 3 < buf.length && buf[i + 3] === 0x01 ? 4 : 3
}

function splitAccessUnit(buf: Uint8Array): Uint8Array[] {
  const nals: Uint8Array[] = []
  let start = findStartCode(buf, 0)
  while (start !== -1) {
    const dataStart = start + startCodeLen(buf, start)
    const next = findStartCode(buf, dataStart)
    const end = next === -1 ? buf.length : next
    if (dataStart < end) nals.push(buf.subarray(dataStart, end))
    start = next
  }
  return nals
}

export class Decoder {
  private videoDecoder: VideoDecoder | null = null
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D

  private pendingBeforeConfig: Array<{ au: Uint8Array[]; frame: VideoFrameRecord }> = []

  private sps: Uint8Array | null = null
  private pps: Uint8Array | null = null
  private configured = false
  private codec = ''
  private fps = 60
  private seenKeyframe = false
  private droppedBeforeKeyframe = 0

  private frameCount = 0
  private fpsWindowStart = performance.now()
  private measuredFps = 0

  public onFps: ((fps: number) => void) | null = null
  public onFirstFrame: (() => void) | null = null
  private firstFrameDrawn = false

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) throw new Error('2d canvas context unavailable')
    this.ctx = ctx
    if (typeof VideoDecoder === 'undefined') {
      throw new Error('WebCodecs VideoDecoder is not available in this browser')
    }
  }

  /**
   * Prepare before requesting a new stream. Codec and dimensions come from SPS;
   * video may arrive before the `started` control message.
   */
  configure(_codec: string, _width?: number, _height?: number, fps?: number): void {
    this.reset()
    if (fps && fps > 0) this.fps = fps
  }

  /** Decode a complete record, including its final NAL without lookahead. */
  feedFrame(frame: VideoFrameRecord): void {
    const au = splitAccessUnit(frame.data)
    if (au.length === 0) return
    for (const nal of au) {
      if (nalType(nal) === NAL_SPS && !codecStringFromSps(nal)) return
      if (nalType(nal) === NAL_PPS && (nal.length < 2 || nal.length > 65535)) return
    }
    for (const nal of au) {
      if (nalType(nal) === NAL_SPS) this.sps = nal.slice()
      else if (nalType(nal) === NAL_PPS) this.pps = nal.slice()
    }
    this.emitAU(au, frame)
  }

  private emitAU(au: Uint8Array[], frame: VideoFrameRecord): void {
    const carriesParams = au.some((n) => {
      const t = nalType(n)
      return t === NAL_SPS || t === NAL_PPS
    })
    if (carriesParams && this.sps && this.pps) {
      this.configureDecoder(this.sps, this.pps)
    }

    const isKey = (frame.flags & 1) !== 0

    // A stream is joined mid-GOP: the agent's ffmpeg is already running, so the
    // first access units received are the tail of the previous GOP and reference
    // frames (and a PPS) that were never sent. Feeding those to VideoDecoder
    // raises a fatal decode error, which moves it to `closed` and kills the
    // IDR that follows. So everything before the first keyframe is dropped.
    if (!this.seenKeyframe) {
      if (!isKey) {
        this.droppedBeforeKeyframe++
        return
      }
      this.seenKeyframe = true
      if (this.droppedBeforeKeyframe > 0) {
        console.info(
          `[decoder] dropped ${this.droppedBeforeKeyframe} access unit(s) before the first keyframe`
        )
      }
    }

    if (!this.configured) {
      // Keyframe arrived but SPS/PPS have not: hold it so the GOP is not lost.
      if (this.pendingBeforeConfig.length < 8) this.pendingBeforeConfig.push({ au, frame })
      return
    }
    if (!this.videoDecoder || this.videoDecoder.state !== 'configured') return

    // Annex B -> AVCC: replace start codes with 4-byte lengths.
    let size = 0
    for (const n of au) size += 4 + n.length
    const avcc = new Uint8Array(size)
    let o = 0
    for (const n of au) {
      avcc[o++] = (n.length >> 24) & 0xff
      avcc[o++] = (n.length >> 16) & 0xff
      avcc[o++] = (n.length >> 8) & 0xff
      avcc[o++] = n.length & 0xff
      avcc.set(n, o)
      o += n.length
    }

    const timestamp = frame.timestampMs * 1000
    const duration = Math.round(1_000_000 / this.fps)
    try {
      this.videoDecoder.decode(
        new EncodedVideoChunk({
          type: isKey ? 'key' : 'delta',
          timestamp,
          duration,
          data: avcc as unknown as BufferSource
        })
      )
    } catch (e) {
      if (!(e instanceof DOMException && e.name === 'InvalidStateError')) {
        console.warn('[decoder] decode threw', e)
      }
    }
  }

  /**
   * A fatal VideoDecoder error moves it to `closed`, after which every decode
   * throws. Recover by tearing the decoder down and waiting for the next
   * SPS/PPS + keyframe, rather than leaving a dead decoder in place.
   */
  private onDecoderError(e: DOMException): void {
    console.error('[decoder] error', e)
    this.configured = false
    this.seenKeyframe = false
    this.sps = null
    this.pps = null
    this.pendingBeforeConfig = []
    this.videoDecoder = null
  }

  private configureDecoder(sps: Uint8Array, pps: Uint8Array): void {
    const codec = codecStringFromSps(sps)
    if (!codec) return
    if (this.configured && this.codec === codec) return

    if (this.videoDecoder && this.videoDecoder.state !== 'closed') {
      try { this.videoDecoder.close() } catch { /* ignore */ }
    }

    this.configured = false
    this.seenKeyframe = false
    try {
      this.videoDecoder = new VideoDecoder({
        output: (frame) => this.onFrame(frame),
        error: (e) => this.onDecoderError(e)
      })
      this.videoDecoder.configure({
        codec,
        // codedWidth/codedHeight come from the SPS inside `description`.
        description: buildAvcC(sps, pps) as unknown as BufferSource,
        optimizeForLatency: true
      })
    } catch (e) {
      console.error('[decoder] configure failed', codec, e)
      this.close()
      return
    }

    this.codec = codec
    this.configured = true
    console.info('[decoder] configured', codec)

    if (this.pendingBeforeConfig.length) {
      const queued = this.pendingBeforeConfig
      this.pendingBeforeConfig = []
      for (const pending of queued) this.emitAU(pending.au, pending.frame)
    }
  }

  private onFrame(frame: VideoFrame): void {
    const w = frame.displayWidth || frame.codedWidth
    const h = frame.displayHeight || frame.codedHeight
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w
      this.canvas.height = h
    }
    this.ctx.drawImage(frame as unknown as CanvasImageSource, 0, 0, w, h)
    frame.close()

    this.frameCount++
    this.tickFps()
    if (!this.firstFrameDrawn) {
      this.firstFrameDrawn = true
      this.onFirstFrame?.()
    }
  }

  /** Rolling fps over decoded frames (not received bytes). */
  private tickFps(): void {
    const now = performance.now()
    const dt = (now - this.fpsWindowStart) / 1000
    if (dt >= 1) {
      this.measuredFps = Math.round(this.frameCount / dt)
      this.frameCount = 0
      this.fpsWindowStart = now
      this.onFps?.(this.measuredFps)
    }
  }

  get currentFps(): number {
    return this.measuredFps
  }

  reset(): void {
    this.pendingBeforeConfig = []
    this.sps = null
    this.pps = null
    this.configured = false
    this.codec = ''
    this.frameCount = 0
    this.measuredFps = 0
    this.firstFrameDrawn = false
    this.seenKeyframe = false
    this.droppedBeforeKeyframe = 0
    try { this.videoDecoder?.close() } catch { /* ignore */ }
    this.videoDecoder = null
  }

  close(): void {
    try { this.videoDecoder?.close() } catch { /* ignore */ }
    this.videoDecoder = null
    this.configured = false
  }
}
