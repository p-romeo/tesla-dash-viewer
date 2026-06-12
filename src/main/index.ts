import { app, BrowserWindow, dialog, ipcMain, net, protocol, shell } from 'electron'
import { join } from 'path'
import { createReadStream, statSync, writeFileSync } from 'fs'
import { Readable } from 'stream'
import { scanDrive, findDefaultRoot } from './scanner'
import { parseRange } from './httpRange'
import { serveTile } from './tileCache'

const isDev = !app.isPackaged

// On Windows, Chromium throttles/suspends compositing for occluded windows, which
// freezes video presentation (and requestVideoFrameCallback) when the window isn't
// on top. Disable it so playback and the sync loop keep running behind other apps.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')

/**
 * Register a privileged `media://` scheme BEFORE the app is ready. This lets the
 * renderer load arbitrary on-disk video files via `media://local/<encoded-path>`
 * with full HTTP range-request support (essential for video seeking), while the
 * main process stays in control of exactly which files are served.
 *
 * `tiles://` (M8) serves OSM map tiles through a disk cache with network
 * fallback (tileCache.ts), so the map works offline once an area has been
 * viewed. Like media:// it needs supportFetchAPI (MapLibre loads raster tiles
 * via fetch in the renderer).
 */
protocol.registerSchemesAsPrivileged([
  // corsEnabled is required since Electron 39.8.10 (security fix #51272):
  // without it, cross-origin fetch()/XHR from the file:// renderer to these
  // schemes is blocked outright — map tiles and the telemetry CSV stop loading.
  {
    scheme: 'media',
    privileges: {
      standard: true,
      secure: true,
      stream: true,
      supportFetchAPI: true,
      corsEnabled: true,
      bypassCSP: true
    }
  },
  {
    scheme: 'tiles',
    privileges: {
      standard: true,
      secure: true,
      stream: true,
      supportFetchAPI: true,
      corsEnabled: true,
      bypassCSP: true
    }
  }
])

/** Decode a media:// URL back to the absolute file path it points at. */
function decodeMediaPath(rawUrl: string): string {
  const url = new URL(rawUrl)
  // pathname looks like "/<encodeURIComponent(absPath)>"
  return decodeURIComponent(url.pathname.replace(/^\//, ''))
}

function contentTypeFor(p: string): string {
  const lower = p.toLowerCase()
  if (lower.endsWith('.mp4')) return 'video/mp4'
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.csv')) return 'text/csv'
  if (lower.endsWith('.json')) return 'application/json'
  return 'application/octet-stream'
}

/**
 * Serve a local file over media:// WITH HTTP range support. Range support is
 * mandatory: without a 206 + Accept-Ranges response, <video> reports an empty
 * `seekable` range and cannot scrub/seek at all (it can only play sequentially
 * from the start). net.fetch(file://) does NOT do this, so we stream slices via
 * fs ourselves.
 */
function serveMedia(request: GlobalRequest): GlobalResponse {
  const filePath = decodeMediaPath(request.url)
  let size: number
  try {
    size = statSync(filePath).size
  } catch {
    return new Response('Not found', { status: 404 })
  }
  const type = contentTypeFor(filePath)
  const rangeHeader = request.headers.get('Range')

  if (rangeHeader) {
    const range = parseRange(rangeHeader, size)
    if (range.kind === 'unsatisfiable') {
      return new Response(null, {
        status: 416,
        headers: { 'Content-Range': `bytes */${size}`, 'Accept-Ranges': 'bytes' }
      })
    }
    if (range.kind === 'range') {
      const { start, end } = range
      const body = Readable.toWeb(
        createReadStream(filePath, { start, end })
      ) as unknown as ReadableStream<Uint8Array>
      return new Response(body, {
        status: 206,
        headers: {
          'Content-Type': type,
          'Content-Range': `bytes ${start}-${end}/${size}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': String(end - start + 1)
        }
      })
    }
    // 'ignore': malformed Range -> fall through to the full 200 response.
  }

  const body = Readable.toWeb(
    createReadStream(filePath)
  ) as unknown as ReadableStream<Uint8Array>
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': type,
      'Accept-Ranges': 'bytes',
      'Content-Length': String(size)
    }
  })
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1024,
    minHeight: 680,
    backgroundColor: '#0a0c10',
    show: false,
    autoHideMenuBar: true,
    title: 'Tesla Dash Viewer',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
      // Keep video decode and the rAF sync loop running when the window isn't
      // foreground (a media player shouldn't stutter when partially occluded).
      backgroundThrottling: false
    }
  })

  win.once('ready-to-show', () => win.show())

  // Surface renderer logs and load failures in the main-process console (dev aid).
  if (isDev) {
    win.webContents.on('console-message', (_e, _level, message) =>
      console.log('[renderer]', message)
    )
  }
  win.webContents.on('did-fail-load', (_e, code, desc, url) =>
    console.error(`[did-fail-load] ${code} ${desc} ${url}`)
  )

  // Open external links in the default browser, never in-app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  // Dev-only: capture the rendered UI to a PNG (set TESLA_CAPTURE=<path>) for
  // headless visual diagnosis without a foreground window.
  const capturePath = process.env['TESLA_CAPTURE']
  if (capturePath) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        win.webContents
          .capturePage()
          .then((img) => {
            writeFileSync(capturePath, img.toPNG())
            console.log(`[capture] wrote ${capturePath}`)
          })
          .catch((e) => console.error('[capture] failed', e))
      }, 7000)
    })
  }

  return win
}

app.whenReady().then(() => {
  protocol.handle('media', (request) => serveMedia(request))

  // net.fetch (not global fetch) so tile downloads honor the OS proxy config.
  const tileDeps = {
    cacheRoot: join(app.getPath('userData'), 'tile-cache'),
    fetchImpl: (url: string, init: { headers: Record<string, string> }) => net.fetch(url, init),
    // OSM tile policy asks for a distinct UA naming the app + a contact URL.
    userAgent: `TeslaDashViewer/${app.getVersion()} (+https://github.com/p-romeo/tesla-dash-viewer)`
  }
  protocol.handle('tiles', (request) => serveTile(request, tileDeps))

  // --- IPC: drive scanning & folder picking ---
  ipcMain.handle('scan-drive', async (_e, root: string) => {
    const result = await scanDrive(root)
    console.log(
      `[scan] ${root} -> ${result.groups.length} segment group(s), ` +
        `${result.trackSessions.length} track session(s), ` +
        `cameras: [${result.cameras.join(', ')}]`
    )
    return result
  })

  ipcMain.handle('pick-folder', async () => {
    const res = await dialog.showOpenDialog({
      title: 'Select a Tesla footage folder',
      properties: ['openDirectory']
    })
    return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0]
  })

  ipcMain.handle('get-default-root', () =>
    findDefaultRoot([
      // Dev: the repo root holds the sample TeslaCam/TeslaTrackMode fixtures.
      process.cwd(),
      join(app.getAppPath(), '..', '..'),
      app.getAppPath()
    ])
  )

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
