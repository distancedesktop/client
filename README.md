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
SHA-256 certificate fingerprint the agent prints on startup.

Every connection also needs the agent's **viewer token**: the agent refuses
viewers without it. Show it on the agent machine with
`distance-agent --print-token`. The client sends it as `?token=` on the
WebTransport URL (browsers cannot set headers on a WebTransport CONNECT) and
stores it with the connection in this browser's local storage. Connections
saved before this change have no token and are refused until re-added.

Tick **Trusted certificate** and leave the fingerprint blank only when the agent
presents a **CA-trusted** certificate — served through a reverse proxy, or run
with `--cert`/`--key` pointing at a real certificate for that hostname. That mode
omits `serverCertificateHashes` entirely and relies on normal browser PKI
validation, so a self-signed certificate supplied via `--cert`/`--key` will be
rejected.

For a self-signed certificate, keep the fingerprint. The agent only prints it
with `--fingerprint` when it manages its own certificate; for a custom one,
compute it from the DER bytes:

```bash
openssl x509 -in cert.pem -outform der | openssl dgst -sha256
```

## Protocol

Control messages are newline-delimited JSON on one bidirectional stream. See
`src/types.ts` for the message shapes, which track the agent's `src/session.go`.

Video uses framed records on server-initiated unidirectional streams:

| Bytes | Description |
|-------|-------------|
| 1 | Flags; bit 0 marks an IDR/keyframe |
| 8 | Timestamp in milliseconds since stream start, unsigned big-endian |
| 4 | Payload length in bytes, unsigned big-endian |
| N | One complete H.264 access unit in Annex B format |

Reads may split a record or contain several records. The client assembles each
record before decoding its payload as one frame, using the IDR flag and converting
the timestamp to WebCodecs microseconds. Payloads must be between 1 byte and
64 MiB in size. Malformed SPS parameter sets are discarded
without stopping reception.

Run the record-parser and decoder regression tests with Node 24+:

```bash
node --test tests/video.test.mjs
```

## Requirements

A browser with both WebTransport and WebCodecs:

| Browser | Required |
|---------|----------|
| Chrome / Edge | 97+ |
| Firefox | 114+, with WebCodecs enabled |
| Safari | 26.4+ (WebTransport); WebCodecs H.264 needs 16.4+ |
