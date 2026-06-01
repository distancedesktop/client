/// <reference types="vite/client" />

interface ElectronAPI {
  platform: string
}

interface Window {
  electronAPI: ElectronAPI
}
