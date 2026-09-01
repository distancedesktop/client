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

Control messages are newline-delimited JSON on one bidirectional stream; video
is raw H.264 Annex B on server-initiated unidirectional streams. See
`src/types.ts` for the message shapes, which track the agent's `src/session.go`.

## Requirements

A browser with both WebTransport and WebCodecs:

| Browser | Required |
|---------|----------|
| Chrome / Edge | 97+ |
| Firefox | 114+, with WebCodecs enabled |
| Safari | 26.4+ (WebTransport); WebCodecs H.264 needs 16.4+ |
