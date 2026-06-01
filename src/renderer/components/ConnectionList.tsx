import type { ConnectionConfig, ConnectionStatus } from '../lib/types'

interface Props {
  connections: ConnectionConfig[]
  activeId: string | null
  statuses: Record<string, ConnectionStatus>
  onSelect: (config: ConnectionConfig) => void
  onDelete: (id: string) => void
}

const statusLabels: Record<ConnectionStatus, string> = {
  disconnected: '',
  connecting: 'Connecting…',
  connected: 'Connected',
  streaming: 'Streaming',
}

export function ConnectionList({ connections, activeId, statuses, onSelect, onDelete }: Props) {
  if (connections.length === 0) {
    return <div className="empty-state">No connections yet</div>
  }

  return (
    <ul className="connection-list">
      {connections.map((conn) => {
        const status = statuses[conn.id]
        const isActive = conn.id === activeId
        return (
          <li
            key={conn.id}
            className={`connection-item${isActive ? ' active' : ''}${status === 'connecting' ? ' connecting' : ''}`}
          >
            <button className="connection-main" onClick={() => onSelect(conn)}>
              <span className="conn-name">{conn.name}</span>
              <span className="conn-host">{conn.host}:{conn.port}</span>
              {status && status !== 'disconnected' && (
                <span className="conn-status" data-status={status}>
                  {statusLabels[status]}
                </span>
              )}
            </button>
            <button
              className="conn-delete"
              onClick={(e) => { e.stopPropagation(); onDelete(conn.id) }}
              title="Remove connection"
            >
              &times;
            </button>
          </li>
        )
      })}
    </ul>
  )
}
