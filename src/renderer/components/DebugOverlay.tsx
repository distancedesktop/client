import { useState, useEffect } from 'react'
import { getDebugLogs, onDebugLogUpdate } from '../lib/debug'

export function DebugOverlay() {
  const [visible, setVisible] = useState(false)
  const [logs, setLogs] = useState<string[]>(getDebugLogs)

  useEffect(() => {
    const unsub = onDebugLogUpdate(() => {
      setLogs([...getDebugLogs()])
    })
    return unsub
  }, [])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'd' && e.metaKey && e.shiftKey) {
        setVisible(v => !v)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  if (!visible) return null

  return (
    <div style={{
      position: 'fixed',
      bottom: 0,
      left: 0,
      right: 0,
      height: '35vh',
      background: 'rgba(0,0,0,0.92)',
      color: '#0f0',
      fontFamily: 'monospace',
      fontSize: '11px',
      lineHeight: '1.5',
      padding: '8px',
      overflowY: 'auto',
      zIndex: 9999,
      borderTop: '2px solid #0f0',
    }}>
      <div style={{ position: 'sticky', top: 0, background: '#000', paddingBottom: 4, display: 'flex', gap: 8 }}>
        <span style={{ color: '#0f0', fontWeight: 'bold' }}>Debug Logs</span>
        <button onClick={() => setVisible(false)} style={{ background: 'none', border: '1px solid #0f0', color: '#0f0', cursor: 'pointer' }}>Close</button>
        <button onClick={() => { (document.querySelector('.debug-log-container') as HTMLElement)?.scrollTo(0, 0) }} style={{ background: 'none', border: '1px solid #0f0', color: '#0f0', cursor: 'pointer' }}>Scroll Top</button>
      </div>
      <div className="debug-log-container" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
        {logs.length === 0 && <span style={{ color: '#888' }}>No logs yet. Press Cmd+Shift+D to toggle.</span>}
        {logs.map((line, i) => <div key={i}>{line}</div>)}
      </div>
    </div>
  )
}
