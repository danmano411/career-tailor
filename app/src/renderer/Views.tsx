import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { Check, Settings, TemplateInfo } from '../shared/types'
import { Icon, PageHead, errText, tplIcon } from './ui'

type Go = (v: 'compose' | 'templates' | 'settings') => void

export function StatusBadge({ t }: { t: TemplateInfo }) {
  if (t.status === 'valid') return <span className="badge badge-ok"><Icon name="check" size={12} />Valid</span>
  if (t.status === 'warnings') return <span className="badge badge-warn"><Icon name="alert" size={12} />{t.warnings.length} warning{t.warnings.length === 1 ? '' : 's'}</span>
  return <span className="badge badge-bad"><Icon name="x" size={12} />Invalid</span>
}

// ---------- templates ----------

export function TemplatesView({ templates, onRescan }: { templates: TemplateInfo[] | null; onRescan: () => Promise<unknown> }) {
  const [busy, setBusy] = useState(false)
  const rescan = async () => { setBusy(true); try { await onRescan() } finally { setBusy(false) } }
  return (
    <div className="page">
      <PageHead title="Templates"
        sub={<>Every <code>.md</code> file in your templates folder (except <code>skills.md</code>). Edits are picked up automatically.</>}
        actions={<>
          <button className="btn" onClick={rescan} disabled={busy}><Icon name="refresh" className={busy ? 'spin' : undefined} />Re-scan</button>
          <button className="btn" onClick={() => window.api.open('templates')}><Icon name="folder" />Open folder</button>
        </>} />
      {templates === null ? <div className="card skeleton tall" />
        : !templates.length ? (
          <div className="empty">
            <Icon name="file" size={22} />
            <h3>No templates yet</h3>
            <p>A template is your resume written as a small markdown file: <code># Name</code>, then <code>## Sections</code>,
              with a <code>## Technical Skills</code> section of <code>**Label** – a, b, c</code> lines. Drop one into the
              templates folder and it shows up here.</p>
            <div className="row">
              <button className="btn btn-primary" onClick={() => window.api.open('templates')}><Icon name="folder" />Open templates folder</button>
              <button className="btn" onClick={() => window.api.open('docs')}><Icon name="external" />Template format guide</button>
            </div>
          </div>
        ) : (
          <div className="tpl-cards">
            {templates.map((t) => <TemplateCard key={t.path} t={t} />)}
            <p className="dim small">Need the format? <button className="link" onClick={() => window.api.open('docs')}>Template format guide <Icon name="external" size={12} /></button></p>
          </div>
        )}
    </div>
  )
}

function TemplateCard({ t }: { t: TemplateInfo }) {
  const issues = [...t.errors.map((m) => ({ m, bad: true })), ...t.warnings.map((m) => ({ m, bad: false }))]
  return (
    <div className={`tcard tcard-${t.status}`}>
      <div className="tcard-main">
        <span className="tpl-icon" aria-hidden="true"><Icon name={tplIcon(t.icon)} size={17} /></span>
        <div className="tcard-text">
          <span className="tpl-name">{t.title}</span>
          <span className="tpl-file mono" title={t.path}>{t.file}</span>
        </div>
        <StatusBadge t={t} />
        <button className="btn btn-sm btn-ghost" onClick={() => window.api.openPath(t.path)} title="Open in your editor"><Icon name="external" size={14} />Open</button>
      </div>
      {issues.length > 0 && (
        <details className="issues" open={t.status === 'invalid'}>
          <summary><Icon name="chevron" size={12} className="caret" />{t.errors.length ? `${t.errors.length} error${t.errors.length === 1 ? '' : 's'}` : ''}{t.errors.length && t.warnings.length ? ', ' : ''}{t.warnings.length ? `${t.warnings.length} warning${t.warnings.length === 1 ? '' : 's'}` : ''}</summary>
          <ul>{issues.map(({ m, bad }) => <li key={m} className={bad ? 'bad' : 'warn'}><Icon name={bad ? 'x' : 'alert'} size={12} /><span>{m}</span></li>)}</ul>
        </details>
      )}
    </div>
  )
}

// ---------- settings ----------

const MODELS = [
  { id: 'sonnet', label: 'Sonnet (recommended)' },
  { id: 'opus', label: 'Opus' },
  { id: 'haiku', label: 'Haiku' },
]

export function SettingsView({ onSaved }: { onSaved: () => void }) {
  const [s, setS] = useState<Settings | null>(null)
  const [saved, setSaved] = useState<Settings | null>(null)
  const [msg, setMsg] = useState('')
  useEffect(() => { window.api.getSettings().then((x) => { setS(x); setSaved(x) }) }, [])
  if (!s) return <div className="page"><div className="card skeleton tall" /></div>

  const set = (k: keyof Settings, v: string) => { setS({ ...s, [k]: v }); setMsg('') }
  const dirty = JSON.stringify(s) !== JSON.stringify(saved)
  const save = async () => {
    try {
      const out = await window.api.saveSettings(s)
      setS(out); setSaved(out); setMsg('Saved')
      onSaved()
    } catch (e) { setMsg(errText(e)) }
  }
  const browse = async (k: keyof Settings, kind: 'folder' | 'file') => {
    const p = await window.api.pick(kind, s[k])
    if (p) set(k, p)
  }
  const preview = s.nameFormat.replace(/\{name\}/g, 'Alex Rivera').replace(/\{company\}/g, 'Acme').replace(/\{role\}/g, 'Software Engineer')

  return (
    <div className="page settings">
      <PageHead title="Settings" sub="Stored in the app's data folder as settings.json."
        actions={<>
          {msg && <span className={`save-msg ${msg === 'Saved' ? '' : 'bad'}`} role="status">{msg === 'Saved' && <Icon name="check" size={14} />}{msg}</span>}
          <button className="btn btn-primary" disabled={!dirty} onClick={save}>Save changes</button>
        </>} />

      <fieldset className="group">
        <legend>Folders</legend>
        <PathField label="Templates" hint="Your resume templates (.md). skills.md here is the default skills file." value={s.templatesDir}
          onChange={(v) => set('templatesDir', v)} onBrowse={() => browse('templatesDir', 'folder')} />
        <PathField label="Output" hint="Finished PDFs are copied here." value={s.outputDir}
          onChange={(v) => set('outputDir', v)} onBrowse={() => browse('outputDir', 'folder')} />
        <PathField label="Runs" hint="One working folder per job: job.md, resume.md, changes.md, run.json." value={s.runsDir}
          onChange={(v) => set('runsDir', v)} onBrowse={() => browse('runsDir', 'folder')} />
        <PathField label="Skills file" optional placeholder="templates folder / skills.md" value={s.skillsFile}
          hint="The skills the agent may add. Leave empty to use skills.md in the templates folder; it is created from your template if missing."
          onChange={(v) => set('skillsFile', v)} onBrowse={() => browse('skillsFile', 'file')} />
      </fieldset>

      <fieldset className="group">
        <legend>Agent</legend>
        <Field label="Agent" hint="Which coding agent does the tailoring.">
          <div className="segmented" role="radiogroup" aria-label="Agent">
            <button role="radio" aria-checked className="seg on">Claude Code</button>
            <button role="radio" aria-checked={false} className="seg" disabled>Codex <span className="soon">soon</span></button>
            <button role="radio" aria-checked={false} className="seg" disabled>API key <span className="soon">soon</span></button>
          </div>
        </Field>
        <Field label="Model" htmlFor="model">
          <select id="model" value={s.model} onChange={(e) => set('model', e.target.value)}>
            {!MODELS.some((m) => m.id === s.model) && <option value={s.model}>{s.model}</option>}
            {MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        </Field>
        <Field label="Python" htmlFor="python" hint='Command or full path to python.exe. Default: "python" (Windows) or "python3".'>
          <input id="python" className="mono" value={s.python} onChange={(e) => set('python', e.target.value)} spellCheck={false} />
        </Field>
      </fieldset>

      <fieldset className="group">
        <legend>Output</legend>
        <Field label="File name format" htmlFor="fmt" hint={<>Tokens: <code>{'{name}'}</code> <code>{'{company}'}</code> <code>{'{role}'}</code>. Preview: <span className="mono">{preview}.pdf</span></>}>
          <input id="fmt" className="mono" value={s.nameFormat} onChange={(e) => set('nameFormat', e.target.value)} spellCheck={false} />
        </Field>
        <Field label="When I press Applied" htmlFor="applog" optional hint="What the agent does with the job's company, role, posting link and today's date, e.g. add a row to your tracker. Empty: the button only marks the run.">
          <textarea id="applog" rows={4} value={s.appliedLog} onChange={(e) => set('appliedLog', e.target.value)}
            placeholder="Add a row to my Notion Applications database (https://notion.so/...): Name = company and role, Status = Applied, Date = today, Link = posting URL." />
        </Field>
        <Field label="Tools for that" htmlFor="apptools" optional hint={<>Space-separated tools the agent may use, e.g. <code>mcp__claude_ai_Notion</code> (your Notion connector in Claude).</>}>
          <input id="apptools" className="mono" value={s.appliedTools} onChange={(e) => set('appliedTools', e.target.value)} spellCheck={false} />
        </Field>
        <Field label="Notion database" htmlFor="notiondb" optional hint="Log Applied straight to this Notion database, without the agent (instant, uses no Claude usage). Needs the token below; the instruction above is then not used. Paste the database's own link.">
          <input id="notiondb" className="mono" value={s.notionDatabase} onChange={(e) => set('notionDatabase', e.target.value)} spellCheck={false}
            placeholder="https://www.notion.so/<database id>" />
        </Field>
        <Field label="Notion token" htmlFor="notiontoken" optional hint={<>An internal integration secret from <code>notion.so/profile/integrations</code>. Share the database with that integration (database ••• → Connections).</>}>
          <input id="notiontoken" type="password" className="mono" value={s.notionToken} onChange={(e) => set('notionToken', e.target.value)} spellCheck={false} placeholder="ntn_…" />
        </Field>
      </fieldset>
    </div>
  )
}

function Field({ label, hint, htmlFor, optional, children }: { label: string; hint?: ReactNode; htmlFor?: string; optional?: boolean; children: ReactNode }) {
  return (
    <div className="field">
      <label className="field-name" htmlFor={htmlFor}>{label}{optional && <span className="opt">optional</span>}</label>
      <div className="field-body">
        {children}
        {hint && <p className="hint">{hint}</p>}
      </div>
    </div>
  )
}

function PathField({ label, hint, value, placeholder, optional, onChange, onBrowse }: {
  label: string; hint?: string; value: string; placeholder?: string; optional?: boolean; onChange: (v: string) => void; onBrowse: () => void
}) {
  const id = `f-${label.toLowerCase().replace(/\W+/g, '-')}`
  return (
    <Field label={label} hint={hint} htmlFor={id} optional={optional}>
      <div className="path-row">
        <input id={id} className="mono" value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} spellCheck={false} />
        <button className="btn btn-sm" onClick={onBrowse}>Browse…</button>
        <button className="btn btn-sm btn-icon" onClick={() => window.api.openPath(value)} disabled={!value} title="Open" aria-label={`Open ${label}`}>
          <Icon name="external" size={14} />
        </button>
      </div>
    </Field>
  )
}

// ---------- setup / preflight ----------

export function SetupView({ checks, onRecheck, go }: { checks: Check[] | null; onRecheck: () => Promise<unknown>; go: Go }) {
  const [installing, setInstalling] = useState(false)
  const [log, setLog] = useState<string[]>([])
  const [result, setResult] = useState<{ ok: boolean; output: string } | null>(null)
  const logRef = useRef<HTMLPreElement>(null)
  useEffect(() => window.api.onTectonicProgress((l) => setLog((x) => [...x.slice(-200), l])), [])
  useEffect(() => { logRef.current?.scrollTo(0, logRef.current.scrollHeight) }, [log])

  const install = async () => {
    setInstalling(true); setLog([]); setResult(null)
    try { setResult(await window.api.installTectonic()) } catch (e) { setResult({ ok: false, output: errText(e) }) }
    setInstalling(false)
    onRecheck()
  }
  const allOk = checks?.every((c) => c.ok)
  const action = (c: Check): ReactNode => {
    if (c.ok) return null
    if (c.id === 'tectonic') return <button className="btn btn-sm btn-primary" disabled={installing || !checks?.find((x) => x.id === 'python')?.ok} onClick={install}>
      {installing ? <Icon name="spinner" size={14} className="spin" /> : <Icon name="download" size={14} />}{installing ? 'Installing…' : 'Install'}</button>
    if (c.id === 'python') return <button className="btn btn-sm" onClick={() => go('settings')}>Settings</button>
    if (c.id === 'templates') return <>
      <button className="btn btn-sm" onClick={() => window.api.open('templates')}>Open folder</button>
      <button className="btn btn-sm" onClick={() => go('templates')}>Details</button>
    </>
    return null
  }

  return (
    <div className="page setup">
      <PageHead title="Setup" sub="Career Tailor needs a few things on this computer. Fix anything marked missing, then re-check."
        actions={<button className="btn" onClick={onRecheck} disabled={!checks}><Icon name="refresh" className={!checks ? 'spin' : undefined} />Re-check</button>} />
      <ol className="checklist">
        {(checks ?? PLACEHOLDER).map((c) => (
          <li key={c.id} className={`check ${!checks ? 'pending' : c.ok ? 'ok' : 'bad'}`}>
            <span className="check-icon" aria-label={!checks ? 'checking' : c.ok ? 'ok' : 'missing'}>
              {!checks ? <Icon name="spinner" size={14} className="spin" /> : <Icon name={c.ok ? 'check' : 'x'} size={14} />}
            </span>
            <div className="check-body">
              <div className="check-title">{c.label}</div>
              {checks && <div className="check-detail mono">{c.detail}</div>}
              {checks && !c.ok && <p className="check-fix">{c.fix}{c.id === 'templates' && <> <button className="link" onClick={() => window.api.open('docs')}>Template format guide</button></>}</p>}
              {c.id === 'tectonic' && (installing || result) && (
                <div className="install">
                  {log.length > 0 && <pre ref={logRef} className="install-log">{log.join('\n')}</pre>}
                  {result && <p className={result.ok ? 'ok-text' : 'bad-text'}>{result.ok ? 'Installed: ' : 'Install failed: '}{result.output}</p>}
                </div>
              )}
            </div>
            <div className="check-actions">{checks && action(c)}</div>
          </li>
        ))}
      </ol>
      <div className="row">
        <button className={`btn ${allOk ? 'btn-primary' : ''}`} onClick={() => go('compose')}>
          {allOk ? 'Start tailoring' : 'Continue anyway'}<Icon name="arrow" size={14} />
        </button>
      </div>
    </div>
  )
}

const PLACEHOLDER: Check[] = [
  { id: 'python', label: 'Python 3', ok: false, detail: '', fix: '' },
  { id: 'claude', label: 'Claude Code', ok: false, detail: '', fix: '' },
  { id: 'tectonic', label: 'Tectonic (PDF engine)', ok: false, detail: '', fix: '' },
  { id: 'templates', label: 'A valid template', ok: false, detail: '', fix: '' },
]
