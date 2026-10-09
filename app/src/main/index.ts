import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell, Menu } from 'electron'
import { spawn } from 'child_process'
import { randomBytes } from 'crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { basename, dirname, isAbsolute, join } from 'path'
import type { Ats, Detail, OpenTarget, Run, Settings } from '../shared/types'
import {
  BACKEND, DOCS_URL, PY_ENV, getSettings, installTectonic, knownTemplates, lastJson, loadSettings, preflight, py,
  saveSettings, scanTemplates, skillsPath, watchTemplates,
} from './setup'
import { appIcon, routineStatus, startRoutine } from './routine'

// Dev/test only: point userData and Documents at a scratch folder so a test launch never touches real settings.
if (process.env['CAREER_TAILOR_HOME']) {
  app.setPath('userData', join(process.env['CAREER_TAILOR_HOME'], 'userData'))
  app.setPath('documents', process.env['CAREER_TAILOR_HOME'])
}

const MAX_RUNNING = 3 // fixed cap; each run is a full agent session

type Rec = Run & { template_snapshot?: string }

let win: BrowserWindow | null = null
const live = new Map<string, Run>() // runs started this session
const queue: { id: string; jdPath: string; url: string }[] = []

const runs = () => getSettings().runsDir
const inbox = () => join(runs(), '_inbox')
const readJson = (p: string): Rec | null => {
  try { return JSON.parse(readFileSync(p, 'utf-8')) } catch { return null }
}
const readText = (p: string): string | null => {
  try { return readFileSync(p, 'utf-8').replace(/\r\n/g, '\n') } catch { return null }
}
const ls = (d: string) => { try { return readdirSync(d) } catch { return [] } }
/** A run's folder. Older records store it relative to the project ("jobs/<name>"), so fall back to <runs>/<name>. */
const folderOf = (r: Run) => {
  if (!r.folder) return null
  if (isAbsolute(r.folder)) return r.folder
  const direct = join(runs(), r.folder)
  return existsSync(direct) ? direct : join(runs(), basename(r.folder))
}
/** A run's template file. Older records store just an id ("swe"): look for <templates>/<id>.md. */
const templateOf = (r: Run) => {
  if (r.template && existsSync(r.template)) return r.template
  const dir = getSettings().templatesDir
  const name = basename(r.template || '').replace(/\.md$/i, '')
  return name ? join(dir, `${name}.md`) : ''
}

/** Every run record on disk: <runs>/<folder>/run.json and <runs>/_inbox/<id>.json, deduped by id (folder wins). */
function history(): Map<string, Rec> {
  const out = new Map<string, Rec>()
  const files = [
    ...ls(runs()).filter((d) => !d.startsWith('_')).map((d) => join(runs(), d, 'run.json')),
    ...ls(inbox()).filter((f) => f.endsWith('.json')).map((f) => join(inbox(), f)),
  ]
  for (const f of files) {
    const r = readJson(f)
    if (!r?.id) continue
    const prev = out.get(r.id)
    out.set(r.id, { ...r, ...prev, template_snapshot: prev?.template_snapshot ?? r.template_snapshot })
  }
  return out
}

function list(): Run[] {
  const all = new Map<string, Run>()
  for (const [id, { template_snapshot, ...r }] of history()) all.set(id, { ...r, hasSnapshot: !!template_snapshot })
  for (const [id, r] of live) {
    const disk = all.get(id)
    if (!disk || r.status === 'queued' || r.status === 'running') all.set(id, { ...disk, ...r })
  }
  for (const id of applying) { const r = all.get(id); if (r) all.set(id, { ...r, applying: true }) }
  return [...all.values()].sort((a, b) => (b.started ?? '').localeCompare(a.started ?? ''))
}

const changed = () => win?.webContents.send('runs:changed')
// local time, same shape as Python's datetime.now().isoformat(timespec="seconds")
const now = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 19)

function pump() {
  const running = [...live.values()].filter((r) => r.status === 'running').length
  if (running >= MAX_RUNNING || !queue.length) return
  const { id, jdPath, url } = queue.shift()!
  const run = live.get(id)!
  const s = getSettings()
  Object.assign(run, { status: 'running', started: now() })
  changed()
  const args = [
    join(BACKEND, 'tailor.py'), '--template', run.template, '--jd-file', jdPath, '--work-dir', s.runsDir,
    '--out-dir', s.outputDir, '--skills', skillsPath(), '--agent', s.agent, '--model', s.model, '--id', id,
    '--name-format', s.nameFormat, '--templates-dir', s.templatesDir, ...(url ? ['--url', url] : []),
  ]
  const child = spawn(s.python, args, { cwd: BACKEND, env: PY_ENV, windowsHide: true })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (d) => (stdout += d))
  child.stderr.on('data', (d) => (stderr += d))
  const finish = (fallback: string) => {
    if (run.status !== 'running') return
    const rec = lastJson<Rec>(stdout)
    Object.assign(run, rec ?? { status: 'failed', error: stderr.trim().slice(-600) || fallback, finished: now() })
    if (!['done', 'failed'].includes(run.status)) run.status = 'failed' // record without a final status
    try {
      writeFileSync(join(inbox(), `${id}.log`), `${stdout}\n--- stderr ---\n${stderr}`, 'utf-8')
      writeFileSync(join(inbox(), `${id}.json`), JSON.stringify({ ...rec, ...run }, null, 1), 'utf-8')
    } catch { /* runs folder gone; the record still lives in memory */ }
    changed()
    pump()
  }
  child.on('error', (e) => finish(`Could not start ${s.python}: ${e.message}`))
  child.on('close', (code) => finish(`tailor.py exited with code ${code}`))
  pump()
}

function tailor(template: string, jd: string, url = ''): string {
  if (template === 'auto') {
    if (knownTemplates().filter((x) => x.status !== 'invalid').length < 2) throw new Error('Auto needs at least two valid templates.')
  } else {
    const t = knownTemplates().find((x) => x.path === template)
    if (!t) throw new Error('Pick a template from the templates folder.')
    if (t.status === 'invalid') throw new Error(`${t.file} is not a valid template: ${t.errors[0] ?? ''}`)
  }
  if (!jd.trim()) throw new Error('Empty job description.')
  const id = randomBytes(4).toString('hex')
  mkdirSync(inbox(), { recursive: true })
  const jdPath = join(inbox(), `${id}.txt`)
  writeFileSync(jdPath, jd, 'utf-8')
  const title = jd.split('\n').map((l) => l.trim()).find(Boolean)?.slice(0, 90)
  live.set(id, { id, template, status: 'queued', title, started: now() })
  queue.push({ id, jdPath, url: /^https?:\/\/\S+$/i.test(url.trim()) ? url.trim() : '' })
  changed()
  pump()
  return id
}

const find = (id: string): Rec | undefined => history().get(id) ?? live.get(id)

/** You applied: mark the run and let the agent log it per your "When I apply" instruction (applied.py). */
const applying = new Set<string>() // runs whose Applied log is in flight; survives leaving the run page

async function applied(id: string): Promise<Run['applied']> {
  if (applying.has(id)) throw new Error('Already logging this application.')
  const r = find(id)
  const folder = r && folderOf(r)
  const file = folder ? join(folder, 'run.json') : ''
  if (!file || !existsSync(file)) throw new Error('This run has no run.json to mark (still running, or its folder is gone).')
  const s = getSettings()
  applying.add(id)
  changed()
  let res
  try {
    // Notion token and database set: applied.py writes the row through Notion's API, no agent (token via env, not argv)
    const notion = s.notionToken && s.notionDatabase ? ['--notion', s.notionDatabase] : []
    res = await py('applied.py', [file, ...notion, '--instruction', s.appliedLog, '--tools', s.appliedTools],
      { timeout: 600_000, env: { NOTION_TOKEN: s.notionToken } })
  } finally {
    applying.delete(id)
    changed()
  }
  const out = lastJson<Run['applied']>(res.stdout)
  if (!out) throw new Error((res.stderr || res.stdout).trim().slice(-600) || `applied.py exited with code ${res.code}`)
  return out
}

/** Clicked Applied by mistake: clear the mark so Applied can be pressed again. The logged entry (e.g. the Notion
 *  row) is not touched; delete it there. */
function unapply(id: string) {
  if (applying.has(id)) throw new Error('This application is still being logged.')
  const r = find(id)
  const folder = r && folderOf(r)
  const file = folder ? join(folder, 'run.json') : ''
  const rec = file ? readJson(file) : null
  if (!rec) throw new Error('This run has no run.json.')
  delete (rec as Run).applied
  writeFileSync(file, JSON.stringify(rec, null, 1), 'utf-8')
  changed()
}

async function ats(templatePath: string, resumePath: string, redacted = false): Promise<Ats> {
  const skills = skillsPath()
  const r = await py('resume.py', ['ats', templatePath, resumePath, ...(existsSync(skills) ? ['--skills', skills, ...(redacted ? ['--redact'] : [])] : [])])
  const j = lastJson<Ats>(r.stdout)
  return j
    ? { ok: !!j.ok, errors: j.errors ?? [], added: j.added ?? [], dropped: j.dropped ?? [], reorders: j.reorders ?? [] }
    : { ok: false, errors: [(r.stderr || r.stdout).trim().slice(-600) || `resume.py ats exited with code ${r.code}`], added: [], dropped: [], reorders: [] }
}

/** `- C · part of: C++ (...)` lines under ## Adjacent in the skills file: why each adjacent skill is allowed */
function nearNotes(skills: string[]): Record<string, string> {
  const text = readText(skillsPath()) ?? ''
  const adj = text.split(/^## Adjacent.*$/m)[1]?.split(/^## /m)[0] ?? ''
  const notes: Record<string, string> = {}
  for (const line of adj.split('\n')) {
    // "- C · part of: C++ work" (backend/prompts/skill-rules.md); older "near:" lines show as-is
    const m = line.match(/^- (.+?) · ((?:same as|part of|describes|named in|near): .+)$/i)
    if (m) notes[m[1].trim().toLowerCase()] = m[2].trim()
  }
  return Object.fromEntries(skills.map((s) => [s, notes[s.trim().toLowerCase()] ?? '']))
}

async function detail(id: string): Promise<Detail> {
  const r = find(id)
  if (!r) throw new Error(`run ${id} not found`)
  const folder = folderOf(r)
  const resumePath = folder && join(folder, 'resume.md')
  let templatePath = templateOf(r)
  if (r.template_snapshot) {
    templatePath = join(tmpdir(), `career-tailor-${id}-template.md`)
    writeFileSync(templatePath, r.template_snapshot, 'utf-8')
  }
  const hasResume = !!resumePath && existsSync(resumePath)
  const job = folder ? readText(join(folder, 'job.md')) : null
  const kw = job?.match(/^## Keywords\s*\n([\s\S]*?)(?=^## |$(?![\s\S]))/m)?.[1]?.trim() ?? null
  return {
    ats: hasResume && existsSync(templatePath) ? await ats(templatePath, resumePath, !!r.redacted?.length) : null,
    atsAgainst: r.template_snapshot ? 'snapshot' : 'current template',
    template: readText(templatePath),
    resume: hasResume ? readText(resumePath) : null,
    keywords: kw,
    changes: folder ? readText(join(folder, 'changes.md')) : null,
    near: nearNotes(r.new_adjacent ?? []),
  }
}

/** The run's PDF in the output folder. If it's missing (deleted, moved, older run), compile it from the run's
 *  resume.md with render.py, so opening always gives a submittable PDF. */
async function ensurePdf(r: Run, folder: string | null): Promise<string | null> {
  const out = r.output || (r.pdf && existsSync(r.pdf) ? r.pdf : '')
  if (out && existsSync(out)) return out
  const md = folder ? join(folder, 'resume.md') : ''
  if (!md || !existsSync(md)) return null
  const target = out || join(getSettings().outputDir, `${basename(folder!)}.pdf`)
  mkdirSync(dirname(target), { recursive: true })
  const res = await py('render.py', [md, target])
  return existsSync(target) ? target : (console.error(res.stdout, res.stderr), null)
}

async function openPath(p: string): Promise<string> {
  if (!p || !existsSync(p)) return `Not found: ${p || '(empty path)'}`
  return shell.openPath(p)
}

async function open(target: OpenTarget, id?: string): Promise<string> {
  const s = getSettings()
  if (target === 'docs') { await shell.openExternal(DOCS_URL); return '' }
  if (target === 'output') return openPath(s.outputDir)
  if (target === 'templates') return openPath(s.templatesDir)
  if (target === 'runs') return openPath(s.runsDir)
  const r = id ? find(id) : undefined
  if (!r) return 'Run not found.'
  if (target === 'applied') {
    if (!/^https?:\/\//i.test(r.applied?.link ?? '')) return 'No logged entry for this run.'
    await shell.openExternal(r.applied!.link)
    return ''
  }
  if (target === 'posting') {
    if (!/^https?:\/\//i.test(r.url ?? '')) return 'No posting link recorded for this run.'
    await shell.openExternal(r.url!)
    return ''
  }
  const folder = folderOf(r)
  if (target === 'pdf' || target === 'folder') {
    const pdf = await ensurePdf(r, folder)
    if (!pdf) return 'No PDF for this run, and no resume.md to compile one from.'
    if (target === 'pdf') return openPath(pdf)
    shell.showItemInFolder(pdf) // the folder you submit from: PDFs, not the run's markdown
    return ''
  }
  // log: the agent's log in the run folder, else the app's capture of tailor.py's output
  const agentLog = folder ? join(folder, 'agent.log') : ''
  return openPath(agentLog && existsSync(agentLog) ? agentLog : join(inbox(), `${r.id}.log`))
}

async function pick(kind: 'folder' | 'file', current: string) {
  const r = await dialog.showOpenDialog(win!, {
    defaultPath: current || undefined,
    properties: kind === 'folder' ? ['openDirectory', 'createDirectory'] : ['openFile'],
    filters: kind === 'file' ? [{ name: 'Markdown', extensions: ['md'] }] : undefined,
  })
  return r.canceled ? null : r.filePaths[0] ?? null
}

const pushTemplates = () => scanTemplates().then((t) => win?.webContents.send('templates:changed', t))

ipcMain.handle('runs:list', () => list())
ipcMain.handle('routine:status', () => routineStatus())
ipcMain.handle('runs:tailor', (_e, t: string, jd: string, url?: string) => tailor(t, jd, url))
ipcMain.handle('posting:fetch', async (_e, url: string) => {
  const r = await py('scan.py', ['--fetch', url, runs()], { timeout: 120_000 })
  return lastJson<{ text: string; error: string; tailored: string }>(r.stdout) ?? { text: '', error: (r.stderr || r.stdout).trim().slice(-300) || 'fetch failed', tailored: '' }
})
ipcMain.handle('runs:detail', (_e, id: string) => detail(id))
ipcMain.handle('runs:applied', (_e, id: string) => applied(id))
ipcMain.handle('runs:unapply', (_e, id: string) => unapply(id))
ipcMain.handle('open', (_e, target: OpenTarget, id?: string) => open(target, id))
ipcMain.handle('openPath', (_e, p: string) => openPath(p))
ipcMain.handle('pick', (_e, kind: 'folder' | 'file', current: string) => pick(kind, current))
ipcMain.handle('settings:get', () => getSettings())
ipcMain.handle('settings:save', (_e, s: Settings) => {
  const out = saveSettings(s)
  watchTemplates((t) => win?.webContents.send('templates:changed', t))
  pushTemplates()
  changed() // runs folder may have moved
  return out
})
ipcMain.handle('templates:list', (_e, rescan?: boolean) => (rescan || !knownTemplates().length ? scanTemplates() : knownTemplates()))
ipcMain.handle('preflight', () => preflight())
ipcMain.handle('tectonic:install', () => installTectonic((l) => win?.webContents.send('tectonic:progress', l)))

// One process: launching again (shortcut, Start menu) shows the window of the one already running in the tray.
if (!app.requestSingleInstanceLock()) app.quit()
app.on('second-instance', () => showWindow())
app.setAppUserModelId('com.danmano411.careertailor') // Windows toasts need it to match the installed app id

app.whenReady().then(() => {
  loadSettings()
  watchTemplates((t) => win?.webContents.send('templates:changed', t))
  // macOS needs an app menu for Cmd+C/V/Q and the other edit shortcuts; Windows shows none
  Menu.setApplicationMenu(process.platform === 'darwin'
    ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }])
    : null)
  startRoutine(showWindow, changed)
  // started at login: stay in the tray; the scan routine runs without a window
  if (!process.argv.includes('--background')) showWindow()
})
// Closing the window keeps the app (and its scan routine) running in the tray. Ending it: Task Manager.
app.on('window-all-closed', () => {})
app.on('activate', () => showWindow()) // macOS: clicking the Dock icon reopens the window

function showWindow() {
  if (win) {
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    return
  }
  win = new BrowserWindow({
    title: 'Career Tailor',
    ...(appIcon(256) ? { icon: appIcon(256)! } : {}),
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0b0b0c' : '#ffffff',
    show: false,
    webPreferences: { preload: join(__dirname, '../preload/index.js'), contextIsolation: true, sandbox: true },
  })
  win.once('ready-to-show', () => win?.show())
  win.on('closed', () => (win = null)) // free the renderer while hidden; reopening rebuilds it
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  if (process.env['ELECTRON_RENDERER_URL']) win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  else win.loadFile(join(__dirname, '../renderer/index.html'))
}

