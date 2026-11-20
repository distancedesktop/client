import assert from 'node:assert/strict'
import { test } from 'node:test'
import { registerHooks } from 'node:module'
import { VideoRecordParser } from '../src/video.ts'
import { Decoder } from '../src/decoder.ts'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) {
      return nextResolve(`${specifier}.ts`, context)
    }
    return nextResolve(specifier, context)
  }
})
const { StreamPanel } = await import('../src/ui/stream.ts')
const { Transport } = await import('../src/transport.ts')

function wire(flags, timestampMs, data) {
  const bytes = new Uint8Array(13 + data.length)
  const view = new DataView(bytes.buffer)
  bytes[0] = flags
  view.setBigUint64(1, BigInt(timestampMs), false)
  view.setUint32(9, data.length, false)
  bytes.set(data, 13)
  return bytes
}

const records = [
  { flags: 1, timestampMs: 0, data: Uint8Array.of(0, 0, 0, 1, 0x65, 0x80, 9) },
  { flags: 0, timestampMs: 16777217, data: Uint8Array.of(0, 0, 1, 0x41, 0x80) },
  { flags: 0x81, timestampMs: 4294967297, data: Uint8Array.of(0, 0, 1, 0x65, 5, 4, 3, 2, 1) }
]
const bytes = new Uint8Array(records.flatMap(r => [...wire(r.flags, r.timestampMs, r.data)]))

test('records survive every two-part split, including header and payload boundaries', () => {
  for (let at = 0; at <= bytes.length; at++) {
    const parser = new VideoRecordParser()
    assert.deepEqual([...parser.push(bytes.subarray(0, at)), ...parser.push(bytes.subarray(at))], records)
    parser.finish()
  }
})

test('one-byte reads, coalesced records, and varied read sizes preserve payloads and metadata', () => {
  for (const sizes of [[1], [bytes.length], [2, 17, 1, 5, 13], [7, 4, 29, 3]]) {
    const parser = new VideoRecordParser()
    let offset = 0
    let index = 0
    const got = []
    while (offset < bytes.length) {
      const next = offset + sizes[index++ % sizes.length]
      got.push(...parser.push(bytes.subarray(offset, next)))
      offset = next
    }
    parser.finish()
    assert.deepEqual(got, records)
  }
})

test('empty input is harmless, incomplete records are not emitted and fail at EOF', () => {
  const parser = new VideoRecordParser()
  assert.deepEqual(parser.push(new Uint8Array()), [])
  parser.finish()
  const record = wire(1, 1, records[0].data)
  for (let end = 1; end < record.length; end++) {
    const partial = new VideoRecordParser()
    assert.deepEqual(partial.push(record.subarray(0, end)), [])
    assert.throws(() => partial.finish(), /truncated video record/)
  }
})

test('rejects zero/oversized payloads and timestamps that cannot be represented in microseconds', () => {
  for (const length of [0, 64 * 1024 * 1024 + 1, 0xffffffff]) {
    const header = new Uint8Array(13)
    new DataView(header.buffer).setUint32(9, length, false)
    assert.throws(() => new VideoRecordParser().push(header), /invalid video payload length/)
  }
  assert.throws(() => new VideoRecordParser().push(wire(1, 0xffffffffffffffffn, Uint8Array.of(1))), /timestamp/)
})

class MockVideoDecoder {
  static chunks = []
  static configs = []
  static failNextConfigure = false
  state = 'unconfigured'
  configure(config) {
    if (MockVideoDecoder.failNextConfigure) {
      MockVideoDecoder.failNextConfigure = false
      throw new Error('malformed SPS rejected by WebCodecs')
    }
    MockVideoDecoder.configs.push(config)
    this.state = 'configured'
  }
  decode(chunk) { MockVideoDecoder.chunks.push(chunk) }
  close() { this.state = 'closed' }
}
globalThis.VideoDecoder = MockVideoDecoder
globalThis.EncodedVideoChunk = class { constructor(init) { Object.assign(this, init) } }

function decoder() {
  MockVideoDecoder.chunks = []
  MockVideoDecoder.configs = []
  return new Decoder({ getContext: () => ({ drawImage() {} }) })
}
function annexB(...nals) { return new Uint8Array(nals.flatMap(nal => [0, 0, 0, 1, ...nal])) }
const sps = [0x67, 0x64, 0, 0x34, 0xac, 0xd9]
const pps = [0x68, 0xee, 0x3c, 0x80]
const idr = [0x65, 0x80, 0x33]

test('decodes each complete AU immediately, with header keyframe flags and millisecond timestamps', () => {
  const d = decoder()
  const frames = [
    { flags: 1, timestampMs: 1234, data: annexB(sps, pps, idr, [0x65, 0x40, 0x44]) },
    { flags: 0, timestampMs: 1251, data: annexB(idr) }
  ]
  const parser = new VideoRecordParser()
  for (const f of frames) {
    for (const b of wire(f.flags, f.timestampMs, f.data)) {
      for (const frame of parser.push(Uint8Array.of(b))) d.feedFrame(frame)
    }
  }
  assert.equal(MockVideoDecoder.configs[0].codec, 'avc1.640034')
  assert.equal(MockVideoDecoder.chunks.length, 2)
  assert.deepEqual(MockVideoDecoder.chunks.map(c => [c.type, c.timestamp]), [['key', 1234000], ['delta', 1251000]])
  assert.deepEqual([...MockVideoDecoder.chunks[1].data], [0, 0, 0, 3, ...idr])
  assert.deepEqual([...MockVideoDecoder.chunks[0].data].slice(-7), [0, 0, 0, 3, 0x65, 0x40, 0x44])
  d.close()
})

test('drops pre-keyframe AUs and empty data; malformed SPS does not stop following frames', () => {
  const d = decoder()
  d.feedFrame({ flags: 1, timestampMs: 0, data: new Uint8Array() })
  d.feedFrame({ flags: 0, timestampMs: 1, data: annexB(sps, pps, idr) })
  assert.equal(MockVideoDecoder.chunks.length, 0)
  for (const bad of [[0x67], [0x67, 0], [0x67, 0, 0, 2]]) {
    assert.doesNotThrow(() => d.feedFrame({ flags: 1, timestampMs: 2, data: annexB(bad, pps, idr) }))
  }
  d.feedFrame({ flags: 1, timestampMs: 3, data: annexB(sps, pps, idr) })
  assert.equal(MockVideoDecoder.chunks.length, 1)
  assert.equal(MockVideoDecoder.chunks[0].timestamp, 3000)
  d.close()
})

test('WebCodecs configuration failure is contained and a later valid keyframe recovers', () => {
  const d = decoder()
  MockVideoDecoder.failNextConfigure = true
  const warn = console.error
  console.error = () => {}
  try {
    assert.doesNotThrow(() => d.feedFrame({ flags: 1, timestampMs: 1, data: annexB(sps, pps, idr) }))
    d.feedFrame({ flags: 1, timestampMs: 2, data: annexB(sps, pps, idr) })
    assert.ok(MockVideoDecoder.chunks.some(c => c.timestamp === 2000))
  } finally {
    console.error = warn
    d.close()
  }
})

test('start resets before sending; late started preserves the IDR and reset waits for a new keyframe', () => {
  const previousDocument = globalThis.document
  globalThis.document = { getElementById: () => null }
  try {
    for (const videoFirst of [true, false]) {
      const d = decoder()
      const keyframe = { flags: 1, timestampMs: 1, data: annexB(sps, pps, idr) }
      const delta = { flags: 0, timestampMs: 2, data: annexB([0x41, 0x80, 0x33]) }
      d.feedFrame(keyframe)
      MockVideoDecoder.chunks = []

      const panel = Object.create(StreamPanel.prototype)
      const sizes = []
      const statuses = []
      Object.assign(panel, {
        decoder: d,
        selectedDisplayId: 0,
        inputEnabled: true,
        input: { attach() {}, detach() {} },
        stats: { update: size => sizes.push(size) },
        cbs: { onStatusChange: status => statuses.push(status) },
        updateToolbar() {},
        transport: {
          start(displayId, options) {
            assert.equal(displayId, 0)
            assert.equal(options.fps, 60)
            d.feedFrame(delta)
            assert.equal(MockVideoDecoder.chunks.length, 0, 'reset must wait for an IDR')
            const started = () => panel.handleMessage({ type: 'started', codec: 'h264', width: 1920, height: 1080 })
            if (!videoFirst) started()
            d.feedFrame(keyframe)
            if (videoFirst) started()
            d.feedFrame(delta)
          }
        }
      })
      panel.startStream()
      assert.deepEqual(MockVideoDecoder.chunks.map(c => c.type), ['key', 'delta'])
      assert.deepEqual(sizes, [{ width: 1920, height: 1080 }])
      assert.deepEqual(statuses, ['streaming'])
      assert.equal(panel.streaming, true)
      d.close()
    }
  } finally {
    if (previousDocument === undefined) delete globalThis.document
    else globalThis.document = previousDocument
  }
})

test('transport close is harmless when empty, active or already closed', async () => {
  const t = new Transport()
  assert.doesNotThrow(() => t.close())
  for (const fail of [false, true]) {
    let writerCloses = 0
    let sessionCloses = 0
    t.ctrlWriter = {
      close() {
        writerCloses++
        return fail ? Promise.reject(new Error('The session is closed')) : Promise.resolve()
      }
    }
    t.wt = {
      close() {
        sessionCloses++
        if (fail) throw new Error('The session is closed')
      }
    }
    assert.doesNotThrow(() => t.close())
    assert.doesNotThrow(() => t.close())
    assert.equal(t.connected, false)
    assert.equal(writerCloses, 1)
    assert.equal(sessionCloses, 1)
    await new Promise(resolve => setImmediate(resolve))
  }
})

test('transport.closed rejection and close during its notification do not leak rejections', async () => {
  const previousWT = globalThis.WebTransport
  const previousWindow = globalThis.window
  let rejectClosed
  globalThis.WebTransport = class {
    ready = Promise.resolve()
    closed = new Promise((_, reject) => { rejectClosed = reject })
    async createBidirectionalStream() {
      return {
        writable: { getWriter: () => ({ close: () => Promise.reject(new Error('The session is closed')) }) },
        readable: { getReader: () => ({}) }
      }
    }
    close() { throw new Error('The session is closed') }
  }
  globalThis.window = { setInterval: () => 1, clearInterval() {} }
  const t = new Transport()
  t.readControlLoop = async () => {}
  t.readVideoLoop = async () => {}
  let notifications = 0
  t.onMessage(() => {
    notifications++
    t.close()
    throw new Error('The session is closed')
  })
  try {
    await t.connect({ url: 'https://localhost:52020/wt', fingerprints: [] })
    rejectClosed(new Error('The session is closed'))
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(notifications, 1)
    assert.equal(t.connected, false)
  } finally {
    t.close()
    if (previousWT === undefined) delete globalThis.WebTransport
    else globalThis.WebTransport = previousWT
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
  }
})

test('FPS updates refresh the streaming label without replacing Stop or input controls', () => {
  const previousDocument = globalThis.document
  const toolbar = { children: [], append(...nodes) { this.children.push(...nodes) } }
  globalThis.document = {
    createElement: () => ({ addEventListener() {} })
  }
  const panel = Object.create(StreamPanel.prototype)
  const updates = []
  const input = {}
  Object.assign(panel, {
    streaming: true,
    decoder: { currentFps: 0 },
    stats: { update: value => updates.push(value) },
    inputToggle: () => input,
    root: { querySelector: selector => selector === '#stream-toolbar'
      ? toolbar : toolbar.children.find(node => node.className === 'stream-status') }
  })
  try {
    panel.updateToolbar()
    const [status, toggle, stop] = toolbar.children
    assert.equal(status.textContent, 'Streaming (0 fps)')
    for (const fps of [60, 59, 0]) {
      panel.updateFps(fps)
      assert.equal(status.textContent, `Streaming (${fps} fps)`)
      assert.deepEqual(updates.at(-1), { fps })
      assert.equal(toolbar.children[1], toggle)
      assert.equal(toolbar.children[2], stop)
    }
    assert.equal(toggle, input)
    assert.equal(stop.textContent, 'Stop')
    panel.streaming = false
    panel.updateFps(30)
    assert.equal(status.textContent, 'Streaming (0 fps)')
    toolbar.children = []
    panel.streaming = true
    assert.doesNotThrow(() => panel.updateFps(60))
  } finally {
    if (previousDocument === undefined) delete globalThis.document
    else globalThis.document = previousDocument
  }
})
