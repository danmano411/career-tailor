// Settings, backend location, python helper, template discovery/validation, preflight checks.
import { app } from 'electron'
import { execFileSync, spawn } from 'child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, watch, writeFileSync, type FSWatcher } from 'fs'
import { dirname, join, resolve } from 'path'
import type { Check, Settings, TemplateInfo } from '../shared/types'

// dev: <repo>/app/out/main -> <repo>/backend; packaged: resources/backend (electron-builder extraResources)
const RES = app.isPackaged ? process.resourcesPath : resolve(__dirname, '..', '..', '..')
export const BACKEND = join(RES, 'backend')
const EXAMPLES = join(RES, 'examples', 'templates')
export const DOCS_URL = 'https://github.com/danmano411/career-tailor/blob/main/docs/TEMPLATE_FORMAT.md'

const settingsPath = () => join(app.getPath('userData'), 'settings.json')

function defaults(): Settings {
  const home = join(app.getPath('documents'), 'Career Tailor')
  return {
    templatesDir: join(home, 'templates'),
    outputDir: join(home, 'output'),
    runsDir: join(home, 'runs'),
    skillsFile: '',
    python: process.platform === 'win32' ? 'python' : 'python3',
    agent: 'claude',
    model: 'sonnet',
    nameFormat: '{name} Resume - {company} {role}',
    appliedLog: '',
    appliedTools: '',
    notionToken: '',
    notionDatabase: '',
  }
}

let settings: Settings

/** Load settings.json (or defaults). First launch: create the folders and copy the bundled example templates in. */
export function loadSettings(): Settings {
  const first = !existsSync(settingsPath())
  let saved: Partial<Settings> = {}
  try { saved = JSON.parse(readFileSync(settingsPath(), 'utf-8')) } catch { /* first launch or corrupt: defaults */ }
  settings = { ...defaults(), ...saved, agent: 'claude' }
  ensureDirs()
  if (first) {
    if (!readdirSync(settings.templatesDir).length && existsSync(EXAMPLES)) {
      // not the example's skills.md: it would become the default allowlist for the user's own templates
      for (const f of readdirSync(EXAMPLES).filter((f) => f.toLowerCase() !== 'skills.md'))
        copyFileSync(join(EXAMPLES, f), join(settings.templatesDir, f))
    }
    writeFileSync(settingsPath(), JSON.stringify(settings, null, 2), 'utf-8')
  }
  return settings
}

export const getSettings = () => settings

export function saveSettings(s: Settings): Settings {
  const d = defaults()
  const str = (v: unknown, fallback: string) => (typeof v === 'string' && v.trim() ? v.trim() : fallback)
  settings = {
    templatesDir: str(s.templatesDir, d.templatesDir),
    outputDir: str(s.outputDir, d.outputDir),
    runsDir: str(s.runsDir, d.runsDir),
    skillsFile: str(s.skillsFile, ''),
    python: str(s.python, d.python),
    agent: 'claude',
    model: str(s.model, d.model),
    nameFormat: str(s.nameFormat, d.nameFormat),
    appliedLog: typeof s.appliedLog === 'string' ? s.appliedLog.trim() : '',
    appliedTools: str(s.appliedTools, ''),
    notionToken: str(s.notionToken, ''),
    notionDatabase: str(s.notionDatabase, ''),
  }
  ensureDirs()
  writeFileSync(settingsPath(), JSON.stringify(settings, null, 2), 'utf-8')
  cache.clear() // python path may have changed
  return settings
}

function ensureDirs() {
  for (const d of [settings.templatesDir, settings.outputDir, settings.runsDir]) {
    try { mkdirSync(d, { recursive: true }) } catch { /* bad path: surfaces in preflight / templates view */ }
  }
}

/** The skills file passed to tailor.py and ats; tailor.py creates it from the template if it doesn't exist. */
export const skillsPath = () => settings.skillsFile || join(settings.templatesDir, 'skills.md')

// macOS apps opened from Finder get launchd's bare PATH (/usr/bin:/bin:...), which misses claude, Homebrew python3
// and anything else the user's shell adds: take PATH from a login shell, as a terminal would see it.
if (process.platform === 'darwin') {
  try {
    const out = execFileSync(process.env.SHELL || '/bin/zsh', ['-ilc', 'printf "__PATH__%s" "$PATH"'], { encoding: 'utf-8', timeout: 10_000 })
    const shellPath = out.split('__PATH__').pop()?.trim()
    if (shellPath) process.env.PATH = [...new Set([...shellPath.split(':'), ...(process.env.PATH ?? '').split(':')])].filter(Boolean).join(':')
  } catch { /* keep the inherited PATH */ }
}

export const PY_ENV = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }

export interface Proc { code: number | null; stdout: string; stderr: string }

/** Run a command to completion. `shell` is needed for .cmd shims on Windows (claude). */
export function exec(cmd: string, args: string[], opts: { shell?: boolean; onLine?: (l: string) => void; timeout?: number; env?: Record<string, string> } = {}): Promise<Proc> {
  return new Promise((res) => {
    let stdout = ''
    let stderr = ''
    let child
    try {
      child = spawn(cmd, args, { env: { ...PY_ENV, ...opts.env }, windowsHide: true, shell: opts.shell, timeout: opts.timeout ?? 120_000 })
    } catch (e) {
      return res({ code: null, stdout, stderr: (e as Error).message })
    }
    const line = (d: Buffer) => { if (opts.onLine) for (const l of d.toString().split(/\r?\n/)) if (l.trim()) opts.onLine(l) }
    child.stdout.on('data', (d: Buffer) => { stdout += d; line(d) })
    child.stderr.on('data', (d: Buffer) => { stderr += d; line(d) })
    child.on('error', (e) => res({ code: null, stdout, stderr: stderr + e.message }))
    child.on('close', (code) => res({ code, stdout, stderr }))
  })
}

/** Every backend command prints one JSON object on its last stdout line. */
export function lastJson<T>(stdout: string): T | null {
  const last = stdout.trim().split(/\r?\n/).pop() ?? ''
  try { return JSON.parse(last) } catch { return null }
}

export const py = (script: string, args: string[], opts?: Parameters<typeof exec>[2]) =>
  exec(settings.python, [join(BACKEND, script), ...args], opts)

const tail = (s: string) => s.trim().split(/\r?\n/).slice(-6).join('\n')

// ---------- templates ----------

const cache = new Map<string, { mtime: number; info: TemplateInfo }>()
let latest: TemplateInfo[] = []

// Display title + icon per template. templates.json in the templates folder wins, e.g.
// { "pm.md": { "title": "Product Management", "icon": "briefcase" } }; otherwise guessed from file-name words.
const GUESS: [RegExp, string, string][] = [
  [/\b(swe|sde|software|backend|frontend|fullstack|full-stack|web)\b/, 'Software Engineering', 'code'],
  [/\b(ml|ai|machine|learning|data|ds|analytics)\b/, 'Machine Learning / Data', 'sparkles'],
  [/\b(pm|apm|product)\b/, 'Product Management', 'briefcase'],
  [/\b(av|autonomous|robotics|robot|self-driving|vehicles?)\b/, 'Autonomous Vehicles', 'car'],
  [/\b(quant|finance|trading)\b/, 'Quantitative / Finance', 'chart'],
  [/\b(research|phd|lab)\b/, 'Research', 'flask'],
  [/\b(design|ux|ui)\b/, 'Design', 'pen'],
]
function describe(dir: string, file: string): { title: string; icon: string } {
  try {
    const meta = JSON.parse(readFileSync(join(dir, 'templates.json'), 'utf-8'))?.[file]
    if (meta?.title) return { title: String(meta.title), icon: String(meta.icon || 'file') }
  } catch { /* no or invalid templates.json: guess */ }
  const words = file.replace(/\.md$/i, '').toLowerCase().replace(/[_.]+/g, ' ').replace(/-/g, ' ')
  const hit = GUESS.find(([re]) => re.test(words))
  if (hit) return { title: hit[1], icon: hit[2] }
  return { title: words.replace(/\b\w/g, (c) => c.toUpperCase()), icon: 'file' }
}

async function validate(path: string, file: string): Promise<TemplateInfo> {
  const mtime = statSync(path).mtimeMs
  const hit = cache.get(path)
  if (hit && hit.mtime === mtime) return { ...hit.info, ...describe(dirname(path), file) } // templates.json may have changed
  const r = await py('resume.py', ['validate', path])
  const j = lastJson<{ ok: boolean; errors?: string[]; warnings?: string[]; name?: string }>(r.stdout)
  const errors = j ? j.errors ?? [] : [tail(r.stderr || r.stdout) || `resume.py validate exited with code ${r.code}`]
  const warnings = j?.warnings ?? []
  const info: TemplateInfo = {
    path, file, errors, warnings, ...describe(dirname(path), file),
    name: file.replace(/\.md$/i, ''), // file name, not the person's name: one person usually has several templates
    status: !j?.ok || errors.length ? 'invalid' : warnings.length ? 'warnings' : 'valid',
  }
  cache.set(path, { mtime, info })
  return info
}

let seq = 0
export async function scanTemplates(): Promise<TemplateInfo[]> {
  const n = ++seq
  const dir = settings.templatesDir
  let files: string[] = []
  try { files = readdirSync(dir).filter((f) => /\.md$/i.test(f) && f.toLowerCase() !== 'skills.md').sort() } catch { /* missing dir: empty */ }
  const out = await Promise.all(files.map((f) => validate(join(dir, f), f).catch((e) => ({
    path: join(dir, f), file: f, name: f, ...describe(dir, f), status: 'invalid' as const, errors: [String(e?.message ?? e)], warnings: [],
  }))))
  if (n === seq) latest = out // a newer scan started meanwhile: let it win
  return latest
}
export const knownTemplates = () => latest

let watcher: FSWatcher | null = null
let timer: NodeJS.Timeout | undefined
/** Watch the templates folder (re-run after settings change); debounced rescan -> onChange. */
export function watchTemplates(onChange: (t: TemplateInfo[]) => void) {
  watcher?.close()
  watcher = null
  try {
    watcher = watch(settings.templatesDir, () => {
      clearTimeout(timer)
      timer = setTimeout(() => scanTemplates().then(onChange), 400)
    })
    watcher.on('error', () => { watcher?.close(); watcher = null })
  } catch { /* folder missing; Re-scan still works */ }
}

// ---------- preflight ----------

export async function preflight(): Promise<Check[]> {
  const [p, c, t, tpl] = await Promise.all([
    exec(settings.python, ['--version'], { timeout: 15_000 }),
    exec('claude --version', [], { shell: true, timeout: 30_000 }), // shell: claude is a .cmd shim on Windows
    // render.find_tectonic(): env CAREER_TAILOR_TECTONIC, PATH, then where setup_tectonic.py installs it
    exec(settings.python, ['-c', `import sys, json; sys.path.insert(0, ${JSON.stringify(BACKEND)}); import render; p = render.find_tectonic(); print(json.dumps({"ok": bool(p), "path": p or ""}))`], { timeout: 30_000 }),
    scanTemplates(),
  ])
  const pyOk = p.code === 0
  const tj = lastJson<{ ok: boolean; path?: string; error?: string }>(t.stdout)
  const valid = tpl.filter((x) => x.status !== 'invalid').length
  return [
    {
      id: 'python', label: 'Python 3', ok: pyOk,
      detail: pyOk ? (p.stdout || p.stderr).trim() : `"${settings.python}" was not found or failed to run.`,
      fix: 'Install Python 3.10 or newer from python.org (tick "Add python.exe to PATH"), or set the Python path in Settings.',
    },
    {
      id: 'claude', label: 'Claude Code', ok: c.code === 0,
      detail: c.code === 0 ? `claude ${c.stdout.trim()}` : 'The `claude` command was not found.',
      fix: 'Install Claude Code (npm install -g @anthropic-ai/claude-code), then run `claude` once in a terminal to sign in.',
    },
    {
      id: 'tectonic', label: 'Tectonic (PDF engine)', ok: !!tj?.ok,
      detail: tj?.ok ? tj.path || 'found' : !pyOk ? 'Needs Python first.' : tj?.error || tail(t.stderr) || 'Not installed.',
      fix: 'Click Install to download Tectonic (about 30 MB) into the app data folder.',
    },
    {
      id: 'templates', label: 'A valid template', ok: valid > 0,
      detail: !pyOk ? 'Needs Python first.' : valid ? `${valid} of ${tpl.length} template${tpl.length === 1 ? '' : 's'} usable` : tpl.length ? `${tpl.length} found, none valid` : `No templates in ${settings.templatesDir}`,
      fix: 'Add a resume in the Career Tailor markdown format to the templates folder (see the template format guide).',
    },
  ]
}

export async function installTectonic(onLine: (l: string) => void) {
  const r = await py('setup_tectonic.py', [], { onLine, timeout: 600_000 })
  const j = lastJson<{ ok: boolean; error?: string; path?: string }>(r.stdout)
  const ok = r.code === 0 && j?.ok !== false
  return { ok, output: ok ? j?.path ?? 'Installed.' : j?.error || tail(r.stderr || r.stdout) || `exit code ${r.code}` }
}
