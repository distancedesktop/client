# client

Web viewer for [Distance](https://github.com/distancedesktop/agent) — connects to
a Distance agent over raw WebTransport and decodes its H.264 stream in the
browser.

No Electron, no framework: vanilla TypeScript built with Vite.

## Usage

```bash
npm install
npm run dev      # dev server on :5173
npm run build    # static bundle in dist/
```

Serve `dist/` from any static host. WebTransport requires a secure context, so
use `https://` (or `localhost`) when serving it.

Add a connection with the agent's host, port (`52020` by default) and the
SHA-256 certificate fingerprint the agent prints on startup. If the agent runs
with `--cert`/`--key` or sits behind a reverse proxy, tick **Trusted
certificate** instead and leave the fingerprint blank.

## Protocol

Control messages are newline-delimited JSON on one bidirectional stream; video
is raw H.264 Annex B on server-initiated unidirectional streams. See
`src/types.ts` for the message shapes, which track the agent's `src/session.go`.

## Requirements

A browser with WebTransport and WebCodecs: Chrome/Edge 97+, or Firefox 114+
with WebCodecs enabled. Safari does not support WebTransport yet.
