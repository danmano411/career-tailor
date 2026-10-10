// Scheduled job scan: runs backend/scan.py once per time window (e.g. noon and evening), from the tray, all day.
// Config: <userData>/routine.json (created with defaults; set "enabled" and fill in "profile").
import { app, Menu, nativeImage, Notification, powerMonitor, shell, Tray, type NativeImage } from 'electron'
import { spawn } from 'child_process'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { BACKEND, PY_ENV, getSettings, lastJson, skillsPath } from './setup'
import type { RoutineStatus } from '../shared/types'

interface Slot { label: string; from: string; to: string }
interface Config { enabled: boolean; startup: boolean; slots: Slot[]; reports_dir?: string; [k: string]: unknown }
interface Result { report: string; new: number; tailored: number; failed: number; error?: string; counts?: Record<string, unknown> }

const DEFAULTS = {
  enabled: false,
  startup: true,
  slots: [{ label: 'noon', from: '11:45', to: '14:30' }, { label: 'evening', from: '18:00', to: '21:00' }],
  profile: 'Describe yourself for the screener: school, degree, graduation date, class standing, work authorization ' +
    '(citizen / green card / visa), target roles and season, preferred locations.',
  web_search: true,
  min_fit: 3,
  max_candidates: 60,
  keep_days: 0, // > 0: each scan deletes scan runs older than this; applied ones are kept (backend/prune.py)
  sources: [
    { name: 'SimplifyJobs', type: 'listings-json', terms: 'Summer 2027',
      url: 'https://raw.githubusercontent.com/SimplifyJobs/Summer2027-Internships/dev/.github/scripts/listings.json',
      mirror: 'https://simplify.jobs/p/{id}',
      include: { category: ['Software', 'Software Engineering', 'AI/ML/Data', 'Data Science, AI & Machine Learning',
        'Product', 'Product Management', 'Quant', 'Quantitative Finance', 'Hardware', 'Hardware Engineering'] } },
    { name: 'Underclassmen', type: 'listings-json',
      url: 'https://raw.githubusercontent.com/Jose-Gael-Cruz-Lopez/underclassmen-opportunities/main/.github/scripts/listings.json' },
    { name: 'LuisaE', type: 'markdown', url: 'https://raw.githubusercontent.com/LuisaE/opportunities/master/README.md' },
    { name: 'Early Career Radar', type: 'earlycareerradar', url: 'https://earlycareerradar.com/summer-internships',
      include: { track: ['SWE', 'ML & AI', 'Data', 'PM', 'Security', 'Quant', 'Hardware', 'Other Engineering', 'Other',
        'Operations'] } },
  ],
}

const file = (n: string) => join(app.getPath('userData'), n)
const CONFIG = () => file('routine.json')
const read = <T>(p: string, fallback: T): T => { try { return JSON.parse(readFileSync(p, 'utf-8')) } catch { return fallback } }
const ran = () => read<{ slots: string[]; lastReport?: string; lastFinished?: string; last?: RoutineStatus['last'] }>(
  file('routine-ran.json'), { slots: [] })

export function config(): Config {
  if (!existsSync(CONFIG())) writeFileSync(CONFIG(), JSON.stringify(DEFAULTS, null, 2), 'utf-8')
  return { ...DEFAULTS, ...read<Partial<Config>>(CONFIG(), {}) } as Config
}

const hm = (d: Date) => d.toTimeString().slice(0, 5) // "HH:MM", local
const day = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
/** The slot whose window contains `d` and hasn't run today, if any. */
function due(cfg: Config, d = new Date()): Slot | undefined {
  const done = ran().slots
  return cfg.slots.find((s) => s.from <= hm(d) && hm(d) < s.to && !done.includes(`${day(d)} ${s.label}`))
}

/** When the next slot starts: the first one today or later that hasn't run and whose window hasn't closed. Inside its
 *  window `at` is now (it starts at the next 5-minute check). `missed`: today's windows that closed without a scan. */
export function routineStatus(): RoutineStatus {
  const cfg = config()
  const r = ran()
  const now = new Date()
  const slots = [...cfg.slots].sort((a, b) => a.from.localeCompare(b.from))
  let next: RoutineStatus['next'] = null
  for (let d = 0; d < 3 && !next; d++) {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + d)
    const s = slots.find((s) => !r.slots.includes(`${day(date)} ${s.label}`) && (d > 0 || hm(now) < s.to))
    if (!s) continue
    const [h, m] = s.from.split(':').map(Number)
    const at = new Date(date.getFullYear(), date.getMonth(), date.getDate(), h, m)
    next = { label: s.label, at: (at < now ? now : at).toISOString() }
  }
  const missed = slots.filter((s) => hm(now) >= s.to && !r.slots.includes(`${day(now)} ${s.label}`)).map((s) => s.label)
  return { enabled: cfg.enabled, running: running && { label: running.label, since: running.since.toISOString() },
    next: cfg.enabled ? next : null, missed: cfg.enabled ? missed : [], last: r.last, report: r.lastReport ?? '' }
}

let tray: Tray | null = null
let running: { label: string; since: Date } | null = null

function scan(label: string, onDone: () => void) {
  if (running) return
  const s = getSettings()
  const cfg = config()
  running = { label, since: new Date() }
  refreshTray()
  const args = [join(BACKEND, 'scan.py'), '--config', CONFIG(), '--state', file('routine-state.json'),
    '--work-dir', s.runsDir, '--out-dir', s.outputDir, '--templates-dir', s.templatesDir, '--skills', skillsPath(),
    '--model', s.model, '--name-format', s.nameFormat, '--label', label,
    ...(cfg.reports_dir ? ['--reports-dir', cfg.reports_dir] : [])]
  const child = spawn(s.python, args, { cwd: BACKEND, env: PY_ENV, windowsHide: true })
  const tick = setInterval(onDone, 15_000) // runs finish one by one during a scan: show them as they land
  let out = ''
  let err = ''
  child.stdout.on('data', (d) => (out += d))
  child.stderr.on('data', (d) => (err += d))
  const finish = () => {
    clearInterval(tick)
    if (!running) return
    running = null
    const res = lastJson<Result>(out)
    if (res?.error?.startsWith('another scan')) { refreshTray(); return } // a manual scan is running: retry next tick
    const r = ran()
    // boards that couldn't be fetched (their postings wait for the next scan) and a scan that crashed show in the app
    const warnings = Object.entries(res?.counts ?? {}).filter(([, v]) => String(v).startsWith('error')).map(([k]) => `${k} unreachable`)
    const last = { finished: new Date().toISOString(), label, tailored: res?.tailored ?? 0, failed: res?.failed ?? 0,
      error: res ? res.error ?? '' : err.trim().split('\n').pop()?.slice(0, 200) || 'scan crashed (see routine-last.log)',
      warnings }
    writeFileSync(file('routine-ran.json'), JSON.stringify({ slots: [...r.slots.slice(-20), `${day(new Date())} ${label}`],
      lastReport: res?.report ?? r.lastReport, lastFinished: last.finished, last }), 'utf-8')
    writeFileSync(file('routine-last.log'), `${out}\n--- stderr ---\n${err}`, 'utf-8')
    const n = res
      ? new Notification({ title: `Job scan (${label}): ${res.tailored} tailored`,
        body: `${res.new} new postings${res.failed ? ` · ${res.failed} failed` : ''}. Click for the report.` })
      : new Notification({ title: 'Job scan failed', body: err.trim().split('\n').pop()?.slice(0, 200) || 'See routine-last.log' })
    n.on('click', () => shell.openPath(res?.report ?? file('routine-last.log')))
    n.show()
    refreshTray()
    onDone()
  }
  child.on('error', (e) => { err += e.message; finish() })
  child.on('close', finish)
}

function refreshTray() {
  if (!tray) return
  const cfg = config()
  const r = ran()
  const status = running
    ? `Scanning (${running.label}) since ${hm(running.since)}…`
    : !cfg.enabled ? 'Routine off (enable it in routine settings)'
    : `Scans daily: ${cfg.slots.map((s) => `${s.label} ${s.from}`).join(', ')}`
  tray.setToolTip(`Career Tailor · ${status}`)
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: status, enabled: false },
    ...(r.lastFinished ? [{ label: `Last scan: ${new Date(r.lastFinished).toLocaleString()}`, enabled: false }] : []),
    { type: 'separator' },
    { label: 'Open Career Tailor', click: () => showWindow() },
    { label: 'Scan now', enabled: !running, click: () => scan('manual', onScanDone) },
    { label: 'Open latest report', enabled: !!r.lastReport, click: () => shell.openPath(r.lastReport!) },
    { label: 'Routine settings…', click: () => { config(); shell.openPath(CONFIG()) } },
  ]))
}

/** The local logo (renderer/public/logo.png, untracked) at `size` px, or null without one. Loading it directly beats
 *  the .exe's icon, which Windows caches per path and keeps showing stale after an icon change. */
export function appIcon(size: number): NativeImage | null {
  const img = nativeImage.createFromPath(join(__dirname, '../renderer/logo.png'))
  return img.isEmpty() ? null : img.resize({ width: size, height: size, quality: 'best' })
}

let showWindow: () => void = () => {}
let onScanDone: () => void = () => {}

/** Tray + scheduler. Checks every 5 minutes and on wake from sleep; a slot runs once, at the first check inside its
 *  window, so a PC that was asleep at noon still scans when it wakes before the window ends. */
export async function startRoutine(show: () => void, scanDone: () => void) {
  showWindow = show
  onScanDone = scanDone
  const cfg = config()
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: cfg.enabled && cfg.startup, args: ['--background'] })
  tray = new Tray(appIcon(16) ?? await app.getFileIcon(process.execPath, { size: 'small' }))
  tray.on('click', () => show())
  refreshTray()
  const tick = () => {
    const c = config()
    const slot = c.enabled && due(c)
    if (slot) scan(slot.label, onScanDone)
    else refreshTray()
  }
  setInterval(tick, 5 * 60 * 1000)
  powerMonitor.on('resume', () => setTimeout(tick, 60 * 1000)) // give the network a minute after wake
  setTimeout(tick, 30 * 1000)
}
