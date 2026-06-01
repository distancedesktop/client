const NAL_TYPE_SPS = 7
const NAL_TYPE_PPS = 8
const NAL_TYPE_IDR = 5
const NAL_TYPE_NON_IDR = 1
const NAL_TYPE_AUD = 9

export interface ParsedNal {
  type: number
  data: Uint8Array
  isSlice: boolean
}

export interface AvcDescription {
  profile: number
  constraints: number
  level: number
  extradata: Uint8Array
}

function findStartCodes(data: Uint8Array): number[] {
  const offsets: number[] = []
  for (let i = 0; i < data.length - 3; i++) {
    if (data[i] === 0 && data[i + 1] === 0) {
      if (data[i + 2] === 1) {
        offsets.push(i)
        i += 2
      } else if (i + 3 < data.length && data[i + 2] === 0 && data[i + 3] === 1) {
        offsets.push(i)
        i += 3
      }
    }
  }
  return offsets
}

export function parseNalUnits(data: Uint8Array): ParsedNal[] {
  const offsets = findStartCodes(data)
  if (offsets.length === 0) return []

  const nals: ParsedNal[] = []
  for (let i = 0; i < offsets.length; i++) {
    const start = offsets[i]
    const end = i + 1 < offsets.length ? offsets[i + 1] : data.length
    const startCodeLen = data[start + 2] === 1 ? 3 : 4
    const nalData = data.slice(start + startCodeLen, end)
    if (nalData.length === 0) continue

    const type = nalData[0] & 0x1f
    nals.push({
      type,
      data: nalData,
      isSlice: type === NAL_TYPE_IDR || type === NAL_TYPE_NON_IDR,
    })
  }
  return nals
}

export function findSpsPps(nals: ParsedNal[]): { sps?: Uint8Array; pps?: Uint8Array } {
  let sps: Uint8Array | undefined
  let pps: Uint8Array | undefined
  for (const nal of nals) {
    if (nal.type === NAL_TYPE_SPS) sps = nal.data
    if (nal.type === NAL_TYPE_PPS) pps = nal.data
  }
  return { sps, pps }
}

function parseSps(sps: Uint8Array): { profile: number; constraints: number; level: number } {
  return {
    profile: sps[1],
    constraints: sps[2],
    level: sps[3],
  }
}

export function buildAvccExtradata(sps: Uint8Array, pps: Uint8Array): Uint8Array {
  const spsSize = sps.length
  const ppsSize = pps.length
  const extradata = new Uint8Array(11 + spsSize + ppsSize)
  const dv = new DataView(extradata.buffer)

  dv.setUint8(0, 1) // version
  dv.setUint8(1, sps[1]) // profile
  dv.setUint8(2, sps[2]) // constraints
  dv.setUint8(3, sps[3]) // level
  dv.setUint8(4, 0xfc | 3) // reserved (6 bits) | NAL length size - 1 (2 bits)
  dv.setUint8(5, 0xe0 | 1) // reserved (3 bits) | number of SPS (5 bits)
  dv.setUint16(6, spsSize, false) // SPS size (big endian)
  extradata.set(sps, 8) // SPS data

  const offset = 8 + spsSize
  dv.setUint8(offset, 1) // number of PPS
  dv.setUint16(offset + 1, ppsSize, false) // PPS size
  extradata.set(pps, offset + 3) // PPS data

  return extradata
}

export function extractAvcDescription(data: Uint8Array): AvcDescription | null {
  const nals = parseNalUnits(data)
  const { sps, pps } = findSpsPps(nals)
  if (!sps || !pps) return null

  const { profile, constraints, level } = parseSps(sps)
  const extradata = buildAvccExtradata(sps, pps)

  return { profile, constraints, level, extradata }
}

export function codecString(profile: number, constraints: number, level: number): string {
  const hex = (n: number) => n.toString(16).padStart(2, '0')
  return `avc1.${hex(profile)}${hex(constraints)}${hex(level)}`
}

export function findAccessUnitBoundaries(nals: ParsedNal[]): number[] {
  const boundaries: number[] = []
  for (let i = 0; i < nals.length; i++) {
    const nal = nals[i]
    if (nal.type === NAL_TYPE_AUD) {
      boundaries.push(i)
    } else if (nal.isSlice && i > 0) {
      const prevIsSlice = nals[i - 1].isSlice
      if (!prevIsSlice) {
        boundaries.push(i)
      }
    }
  }
  return boundaries
}
