import { contextBridge, ipcRenderer } from 'electron'
import type { Api } from '../shared/types'

function on<T>(ch: string, cb: (v: T) => void) {
  const h = (_e: unknown, v: T) => cb(v)
  ipcRenderer.on(ch, h)
  return () => { ipcRenderer.off(ch, h) }
}

const api: Api = {
  list: () => ipcRenderer.invoke('runs:list'),
  routine: () => ipcRenderer.invoke('routine:status'),
  tailor: (t, jd, url) => ipcRenderer.invoke('runs:tailor', t, jd, url),
  fetchPosting: (url) => ipcRenderer.invoke('posting:fetch', url),
  applied: (id) => ipcRenderer.invoke('runs:applied', id),
  unapply: (id) => ipcRenderer.invoke('runs:unapply', id),
  detail: (id) => ipcRenderer.invoke('runs:detail', id),
  open: (target, id) => ipcRenderer.invoke('open', target, id),
  onChange: (cb) => on('runs:changed', cb),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (s) => ipcRenderer.invoke('settings:save', s),
  pick: (kind, current) => ipcRenderer.invoke('pick', kind, current),
  openPath: (p) => ipcRenderer.invoke('openPath', p),
  templates: (rescan) => ipcRenderer.invoke('templates:list', rescan),
  onTemplates: (cb) => on('templates:changed', cb),
  preflight: () => ipcRenderer.invoke('preflight'),
  installTectonic: () => ipcRenderer.invoke('tectonic:install'),
  onTectonicProgress: (cb) => on('tectonic:progress', cb),
}
contextBridge.exposeInMainWorld('api', api)
