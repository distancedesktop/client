import assert from 'node:assert/strict'
import { test } from 'node:test'
import { VideoRecordParser } from '../src/video.ts'
import { Decoder } from '../src/decoder.ts'

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
