import { contextBridge, ipcRenderer } from 'electron'
import type { ScanResult, TeslaApi } from '../shared/types'

const api: TeslaApi = {
  scanDrive: (root: string): Promise<ScanResult> =>
    ipcRenderer.invoke('scan-drive', root),
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke('pick-folder'),
  getDefaultRoot: (): Promise<string | null> =>
    ipcRenderer.invoke('get-default-root'),
  selfTest: process.env['TESLA_SELFTEST'] === '1'
}

contextBridge.exposeInMainWorld('teslaApi', api)
