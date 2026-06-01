import { app, BrowserWindow, screen } from 'electron'
import path from 'path'

const isDev = process.env.NODE_ENV !== 'production' || !app.isPackaged

function createWindow(): void {
  const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize

  const mainWindow = new BrowserWindow({
    width: Math.min(1280, Math.round(screenWidth * 0.8)),
    height: Math.min(800, Math.round(screenHeight * 0.8)),
    minWidth: 800,
    minHeight: 600,
    title: 'Distance Client',
    backgroundColor: '#0f0f0f',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webgl: true,
    },
  })

  if (isDev) {
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  } 
  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
}

app.whenReady().then(createWindow)

app.on('window-all-closed', () => {
  app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})
