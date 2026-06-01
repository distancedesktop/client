import { useState } from 'react'
import { v4 as uuid } from 'uuid'
import type { ConnectionConfig } from '../lib/types'

interface Props {
  onAdd: (config: ConnectionConfig) => void
}

export function AddConnection({ onAdd }: Props) {
  const [name, setName] = useState('')
  const [host, setHost] = useState('')
  const [port, setPort] = useState('52020')
  const [fingerprint, setFingerprint] = useState('')
  const [show, setShow] = useState(false)

  const canSave = name.trim() && host.trim() && port.trim()

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!canSave) return
    onAdd({
      id: uuid(),
      name: name.trim(),
      host: host.trim(),
      port: parseInt(port, 10) || 52020,
      fingerprints: fingerprint.trim() ? [fingerprint.trim()] : [],
    })
    setName('')
    setHost('')
    setPort('52020')
    setFingerprint('')
    setShow(false)
  }

  if (!show) {
    return (
      <button className="add-btn" onClick={() => setShow(true)}>
        + Add Connection
      </button>
    )
  }

  return (
    <form className="add-connection" onSubmit={handleSubmit}>
      <input
        type="text"
        placeholder="Name (e.g. Home PC)"
        value={name}
        onChange={(e) => setName(e.target.value)}
        autoFocus
      />
      <input
        type="text"
        placeholder="Host (IP or hostname)"
        value={host}
        onChange={(e) => setHost(e.target.value)}
      />
      <input
        type="number"
        placeholder="Port"
        value={port}
        onChange={(e) => setPort(e.target.value)}
        min={1}
        max={65535}
      />
      <input
        type="text"
        placeholder="SHA-256 Fingerprint (from server web UI)"
        value={fingerprint}
        onChange={(e) => setFingerprint(e.target.value)}
      />
      <div className="add-actions">
        <button type="submit" disabled={!canSave}>Save</button>
        <button type="button" onClick={() => setShow(false)}>Cancel</button>
      </div>
    </form>
  )
}
