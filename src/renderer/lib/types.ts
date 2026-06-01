export interface ConnectionConfig {
  id: string
  name: string
  host: string
  port: number
  fingerprints: string[]
}

export interface DisplayInfo {
  id: number
  width: number
  height: number
  x: number
  y: number
  refresh_rate: number
}

export type ClientMessage =
  | { type: 'list-displays' }
  | { type: 'start'; display_id: number; fps?: number; codec?: string; bitrate?: number }
  | { type: 'stop' }

export type ServerMessage =
  | { type: 'displays'; displays: DisplayInfo[] }
  | { type: 'started'; width: number; height: number; codec: string }
  | { type: 'stopped' }
  | { type: 'error'; message: string }
  | { type: 'stream-ended' }
  | { type: 'fingerprint-refresh'; algorithm: string; fingerprint: string }

export type ConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'streaming'

export interface StreamState {
  status: ConnectionStatus
  displays: DisplayInfo[]
  width: number
  height: number
  codec: string
  error: string
  selectedDisplayId: number
}
