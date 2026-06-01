import { useState, useCallback } from 'react'
import type { ConnectionConfig, ConnectionStatus } from './lib/types'
import { AddConnection } from './components/AddConnection'
import { ConnectionList } from './components/ConnectionList'
import { StreamPanel } from './components/StreamPanel'
import { DebugOverlay } from './components/DebugOverlay'
import './App.css'

const STORAGE_KEY = 'distance-connections'

function loadConnections(): ConnectionConfig[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

function saveConnections(conns: ConnectionConfig[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(conns))
}

export default function App() {
  const [connections, setConnections] = useState<ConnectionConfig[]>(loadConnections)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [statuses, setStatuses] = useState<Record<string, ConnectionStatus>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})

  const activeConfig = connections.find((c) => c.id === activeId) ?? null

  const handleAdd = useCallback((config: ConnectionConfig) => {
    const updated = [...connections, config]
    setConnections(updated)
    saveConnections(updated)
  }, [connections])

  const handleDelete = useCallback((id: string) => {
    const updated = connections.filter((c) => c.id !== id)
    setConnections(updated)
    saveConnections(updated)
    if (activeId === id) {
      setActiveId(null)
    }
  }, [connections, activeId])

  const handleSelect = useCallback((config: ConnectionConfig) => {
    setActiveId(config.id)
    setErrors((prev) => {
      const next = { ...prev }
      delete next[config.id]
      return next
    })
  }, [])

  const handleStatusChange = useCallback((id: string, status: ConnectionStatus) => {
    setStatuses((prev) => ({ ...prev, [id]: status }))
  }, [])

  const handleError = useCallback((id: string, message: string) => {
    setErrors((prev) => ({ ...prev, [id]: message }))
    setStatuses((prev) => ({ ...prev, [id]: 'disconnected' }))
  }, [])

  const handleUpdateFingerprint = useCallback((id: string, fingerprint: string) => {
    setConnections((prev) => {
      const updated = prev.map((c) => {
        if (c.id !== id) return c
        if (c.fingerprints.includes(fingerprint)) return c
        return { ...c, fingerprints: [...c.fingerprints, fingerprint] }
      })
      saveConnections(updated)
      return updated
    })
  }, [])

  const handleBack = useCallback(() => {
    setActiveId(null)
  }, [])

  return (
    <div className="app">
      {activeConfig ? (
        <div className="stream-view">
          <header className="stream-header">
            <button className="back-btn" onClick={handleBack}>&larr; Back</button>
            <h1>{activeConfig.name}</h1>
            <span className="header-host">{activeConfig.host}:{activeConfig.port}</span>
          </header>
          {errors[activeConfig.id] && (
            <div className="error-banner">
              {errors[activeConfig.id]}
              <button onClick={() => setErrors((prev) => { const n = { ...prev }; delete n[activeConfig.id]; return n })}>
                &times;
              </button>
            </div>
          )}
          <StreamPanel
            config={activeConfig}
            onStatusChange={handleStatusChange}
            onError={handleError}
            onUpdateFingerprint={handleUpdateFingerprint}
          />
        </div>
      ) : (
        <div className="sidebar-view">
          <header className="sidebar-header">
            <h1>Distance Client</h1>
            <p className="subtle">Remote Desktop Viewer</p>
          </header>
          <AddConnection onAdd={handleAdd} />
          <ConnectionList
            connections={connections}
            activeId={null}
            statuses={statuses}
            onSelect={handleSelect}
            onDelete={handleDelete}
          />
          {Object.entries(errors).length > 0 && (
            <div className="error-summary">
              {Object.entries(errors).map(([id, msg]) => {
                const conn = connections.find((c) => c.id === id)
                return (
                  <div key={id} className="error-item">
                    <strong>{conn?.name ?? id}:</strong> {msg}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
      <DebugOverlay />
    </div>
  )
}
