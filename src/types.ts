// Control protocol shared with distancedesktop/agent (src/session.go).
// All control messages are newline-delimited JSON on the bidirectional stream.

export interface ConnectionConfig {
  id: string
  name: string
  host: string
  port: number
  // SHA-256 certificate fingerprints (hex). Multiple entries are kept so a
  // rotated agent cert stays reachable; all of them are pinned at connect time.
  // Empty when trustedCert is set.
  fingerprints: string[]
  // Agent is behind a reverse proxy or serves a publicly trusted cert
  // (agent run with --cert/--key). No fingerprint pinning, no cert manager,
  // so no fingerprint-refresh push either.
  trustedCert?: boolean
}

export interface DisplayInfo {
  id: number
  width: number
  height: number
  x: number
  y: number
  refresh_rate: number
}

// Input messages. NOT IMPLEMENTED SERVER-SIDE: session.go has no `input` case,
// so these fall through to `default:` and come back as
// {"type":"error","message":"unknown type: input"}. Kept behind an
// off-by-default toggle in the stream panel until the agent grows a handler.
export type InputMessage =
  | { type: 'input'; kind: 'mouse'; dx: number; dy: number; buttons: number }
  | { type: 'input'; kind: 'mousedown'; button: number }
  | { type: 'input'; kind: 'mouseup'; button: number }
  | { type: 'input'; kind: 'wheel'; dx: number; dy: number }
  | { type: 'input'; kind: 'key'; code: string; down: boolean }
  | { type: 'input'; kind: 'touch'; id: number; x: number; y: number; phase: 'start' | 'move' | 'end' }

// Client -> Server. `codec` and `bitrate` are accepted by the agent's `start`
// handler even though AGENTS.md documents only display_id/fps.
export type ClientMessage =
  | { type: 'list-displays' }
  | { type: 'start'; display_id: number; fps?: number; codec?: string; bitrate?: number }
  | { type: 'stop' }
  | InputMessage

// Server -> Client.
// - `fingerprint-refresh` is pushed unconditionally on connect when the agent
//   runs its own cert manager, and broadcast on rotation (rotation only reaches
//   sessions subscribed to a live stream).
// - `displays` also arrives unsolicited right after the connect-time
//   fingerprint, before any `list-displays` request.
// - `stream-ended` is synthesized locally when the WebTransport session drops;
//   the agent never sends it.
// - `pong` is NOT IMPLEMENTED SERVER-SIDE: session.go has no `ping` case, so a
//   ping is answered with {"type":"error","message":"unknown type: ping"}.
export type ServerMessage =
  | { type: 'displays'; displays: DisplayInfo[] }
  | { type: 'started'; width: number; height: number; codec: string }
  | { type: 'stopped' }
  | { type: 'stream-ended' }
  | { type: 'error'; message: string }
  | { type: 'fingerprint-refresh'; algorithm: string; fingerprint: string }
  | { type: 'pong'; t: number }

export type ControlMessage = ServerMessage

// Connect payload as encoded in a QR / paste blob by the agent's web UI.
export interface ConnectPayload {
  host: string
  port?: number
  fingerprint: string
  label?: string
}

export type ConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'streaming'
