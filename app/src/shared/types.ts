export type Status = 'queued' | 'running' | 'done' | 'failed'

export interface Settings {
  templatesDir: string
  outputDir: string
  runsDir: string
  /** optional; empty = <templatesDir>/skills.md (tailor.py creates it from the template if missing) */
  skillsFile: string
  python: string
  agent: 'claude'
  model: string
  nameFormat: string
  /** what the agent does when you press Applied (e.g. add a row to a Notion table); empty = just mark the run */
  appliedLog: string
  /** tools that agent may use, space-separated (e.g. an MCP server: mcp__claude_ai_Notion) */
  appliedTools: string
  notionToken: string
  notionDatabase: string
}

/** One template file in the templates folder, with its `resume.py validate` result. */
export interface TemplateInfo {
  path: string
  file: string
  name: string
  /** display title + icon: from templates.json in the templates folder, else guessed from the file name */
  title: string
  icon: string
  status: 'valid' | 'warnings' | 'invalid'
  errors: string[]
  warnings: string[]
}

export interface Check {
  id: 'python' | 'claude' | 'tectonic' | 'templates'
  label: string
  ok: boolean
  detail: string
  fix: string
}

/** One tailoring run: tailor.py's run record, plus app-side fields for live runs. */
export interface Run {
  id: string
  /** absolute path of the template .md */
  template: string
  status: Status
  company?: string
  role?: string
  folder?: string
  pdf?: string
  output?: string
  skills_added?: string[]
  new_adjacent?: string[]
  gaps?: string[]
  error?: string
  started?: string
  finished?: string
  /** first line of the pasted JD, for live runs before the company is known */
  title?: string
  hasSnapshot?: boolean
  /** auto mode: the agent picked `template`, for this reason */
  auto?: boolean
  auto_reason?: string
  /** the job posting's URL, when known */
  url?: string
  /** changes allowed beyond Technical Skills because the employer asks for them, e.g. ["Education dates"] */
  redacted?: string[]
  /** a one-off resume that deviates from its template on purpose: what changed, shown instead of a failed check */
  custom?: string[]
  /** the Applied log is running right now (kept in the main process, so it survives switching runs) */
  applying?: boolean
  /** set when you pressed Applied; link = the entry the agent logged it to */
  applied?: { date: string; ok: boolean; link: string; error: string }
}

/** `resume.py ats` JSON */
export interface Ats {
  ok: boolean
  errors: string[]
  added: string[]
  dropped: string[]
  reorders: { label: string; before: string[]; after: string[] }[]
}

export interface Detail {
  ats: Ats | null
  atsAgainst: 'snapshot' | 'current template'
  template: string | null
  resume: string | null
  keywords: string | null
  changes: string | null
  /** new_adjacent skill -> its `near:` note from the skills file */
  near: Record<string, string>
}

export type OpenTarget = 'pdf' | 'folder' | 'output' | 'log' | 'templates' | 'runs' | 'docs' | 'posting' | 'applied'

/** The scan routine for the sidebar: running now, the next slot, today's missed windows, the last scan's outcome. */
export interface RoutineStatus {
  enabled: boolean
  running: { label: string; since: string } | null
  next: { label: string; at: string } | null
  missed: string[]
  last?: { finished: string; label: string; tailored: number; failed: number; error: string; warnings: string[] }
  report: string
}

export interface Api {
  list(): Promise<Run[]>
  routine(): Promise<RoutineStatus>
  tailor(template: string, jd: string, url?: string): Promise<string>
  /** a posting's text from its link (ATS APIs / the page), or why it couldn't be read; tailored = the run folder if
   *  this job id was already tailored (then nothing is fetched) */
  fetchPosting(url: string): Promise<{ text: string; error: string; tailored: string }>
  applied(id: string): Promise<Run['applied']>
  unapply(id: string): Promise<void>
  detail(id: string): Promise<Detail>
  open(target: OpenTarget, id?: string): Promise<string>
  onChange(cb: () => void): () => void
  getSettings(): Promise<Settings>
  saveSettings(s: Settings): Promise<Settings>
  pick(kind: 'folder' | 'file', current: string): Promise<string | null>
  openPath(p: string): Promise<string>
  templates(rescan?: boolean): Promise<TemplateInfo[]>
  onTemplates(cb: (t: TemplateInfo[]) => void): () => void
  preflight(): Promise<Check[]>
  installTectonic(): Promise<{ ok: boolean; output: string }>
  onTectonicProgress(cb: (line: string) => void): () => void
}
