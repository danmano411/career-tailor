import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { Check, RoutineStatus, Run, TemplateInfo } from '../shared/types'
import { RunDetail } from './Detail'
import { SettingsView, SetupView, StatusBadge, TemplatesView } from './Views'
import { Icon, PageHead, elapsed, errText, runTitle, templateName, tplIcon, when, type IconName } from './ui'

type View = 'compose' | 'templates' | 'settings' | 'setup' | { run: string }

const span = (ms: number) => {
  const m = Math.max(0, Math.round(ms / 60000))
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`
}
const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

/** The auto-scan, live: running (and for how long), else a countdown to the next slot, plus anything wrong with the
 *  last scan (crash, failed tailors, unreachable boards) or a window today that passed without a scan. */
function ScanStatus() {
  const [s, setS] = useState<RoutineStatus | null>(null)
  const [, setTick] = useState(0)
  useEffect(() => {
    const load = () => window.api.routine().then(setS)
    load()
    const poll = setInterval(load, 20_000)
    const tick = setInterval(() => setTick((n) => n + 1), 1000)
    const off = window.api.onChange(load)
    return () => { clearInterval(poll); clearInterval(tick); off() }
  }, [])
  if (!s) return null
  const now = Date.now()
  const last = s.last
  const problems = [
    ...(last?.error ? [`Last scan error: ${last.error}`] : []),
    ...(last?.failed ? [`${last.failed} tailor${last.failed > 1 ? 's' : ''} failed last scan`] : []),
    ...(last?.warnings ?? []),
    ...s.missed.map((m) => `Today's ${m} scan didn't run (PC asleep or app closed?)`),
    ...(s.cut ? [`${s.cut.label} scan from ${clock(s.cut.since)} was cut off (shutdown or app closed) · ${s.running ? 'rerunning now' : 'reruns within 5 min'}`] : []),
  ]
  const [state, head, sub] = s.running
    ? ['running', `Scanning · ${s.running.label}`, `started ${clock(s.running.since)} · ${span(now - Date.parse(s.running.since))}`]
    : !s.enabled ? ['off', 'Auto-scan off', 'turn it on in routine settings (tray menu)']
    : s.next && Date.parse(s.next.at) <= now + 1000 ? ['soon', `Next scan · ${s.next.label}`, 'starting within 5 min']
    : s.next ? ['idle', `Next scan · ${s.next.label}`, `in ${span(Date.parse(s.next.at) - now)} · ${clock(s.next.at)}`]
    : ['off', 'No scan scheduled', '']
  return (<>
    <button className={`scan-status scan-${state} ${problems.length ? 'scan-bad' : ''}`} disabled={!s.report}
      title={s.report ? 'Open the latest scan report' : undefined} onClick={() => window.api.openPath(s.report)}>
      <span className={`dot ${state === 'running' ? 'dot-running' : problems.length ? 'dot-failed' : 'dot-done'}`} />
      <span className="run-text">
        <span className="scan-head">{head}</span>
        {sub && <span className="run-sub">{sub}</span>}
        {last && !s.running && <span className="run-sub">last: {last.label} {clock(last.finished)} · {last.tailored} tailored{last.rerunOf ? ` · rerun of the ${clock(last.rerunOf)} scan that was cut off` : ''}</span>}
        {problems.map((p) => <span key={p} className="scan-problem">{p}</span>)}
      </span>
    </button>
  </>)
}

export function App() {
  const [runs, setRuns] = useState<Run[] | null>(null)
  const [templates, setTemplates] = useState<TemplateInfo[] | null>(null)
  const [checks, setChecks] = useState<Check[] | null>(null)
  const [view, setView] = useState<View>('compose')
  const [, setTick] = useState(0)

  const reload = useCallback(() => window.api.list().then(setRuns), [])
  const [refreshing, setRefreshing] = useState(false)
  useEffect(() => { reload(); return window.api.onChange(reload) }, [reload])
  useEffect(() => { window.api.templates().then(setTemplates); return window.api.onTemplates(setTemplates) }, [])

  const recheck = useCallback(async () => {
    setChecks(null)
    const c = await window.api.preflight()
    setChecks(c)
    window.api.templates().then(setTemplates)
    return c
  }, [])
  useEffect(() => { recheck().then((c) => { if (c.some((x) => !x.ok)) setView('setup') }) }, [recheck])

  const live = runs?.some((r) => r.status === 'running' || r.status === 'queued')
  useEffect(() => {
    if (!live) return
    const t = setInterval(() => setTick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [live])

  const [logo, setLogo] = useState(true) // public/logo.png is a local, untracked file; without it, the CT mark
  const selected = typeof view === 'object' ? view.run : null
  const run = runs?.find((r) => r.id === selected)
  const issues = checks?.filter((c) => !c.ok).length ?? 0
  const nav = (v: View, icon: IconName, label: string, badge?: ReactNode) => (
    <button className={`nav-item ${view === v ? 'active' : ''}`} onClick={() => setView(v)} aria-current={view === v ? 'page' : undefined}>
      <Icon name={icon} size={15} />{label}{badge}
    </button>
  )

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          {logo ? <img className="mark mark-img" src="./logo.png" alt="" onError={() => setLogo(false)} />
            : <span className="mark" aria-hidden="true">CT</span>}
          <span className="brand-name">Career Tailor</span>
        </div>
        <nav className="nav" aria-label="Main">
          {nav('compose', 'plus', 'New tailoring')}
          {nav('templates', 'file', 'Templates', templates?.length ? <span className="count">{templates.length}</span> : null)}
          {nav('settings', 'settings', 'Settings')}
          {nav('setup', 'wrench', 'Setup', issues ? <span className="count count-bad">{issues}</span> : null)}
        </nav>
        <ScanStatus />
        <div className="side-label">History{runs?.length ? <span className="count">{runs.length}</span> : null}
          <button className={`btn btn-sm btn-icon side-refresh ${refreshing ? 'spinning' : ''}`} title="Refresh: show runs that finished since"
            aria-label="Refresh history" onClick={async () => { setRefreshing(true); await reload(); setRefreshing(false) }}>
            <Icon name="refresh" size={13} className={refreshing ? 'spin' : undefined} /></button>
        </div>
        <nav className="runs" aria-label="Runs">
          {runs === null && [0, 1, 2].map((i) => <div key={i} className="run-item skeleton" />)}
          {runs?.length === 0 && <p className="side-empty">No runs yet.</p>}
          {runs?.map((r) => (
            <button key={r.id} className={`run-item ${r.id === selected ? 'selected' : ''}`} onClick={() => setView({ run: r.id })}
              aria-current={r.id === selected ? 'page' : undefined}>
              <span className={`dot dot-${r.status}`} aria-label={r.status} />
              <span className="run-text">
                <span className="run-title" title={runTitle(r)}>{r.company || r.title || 'Untitled posting'}</span>
                {r.role && <span className="run-role" title={r.role}>{r.role}</span>}
                <span className="run-sub">
                  <span className="tag">{templateName(r.template)}</span>
                  {r.grad && <span className="tag tag-grad">GRAD YEAR: {r.grad}</span>}
                  {r.dateClash && <span className="tag tag-grad" title={`Applied before as ${r.dateClash.date}: ${r.dateClash.role}`}>APPLIED AS {r.dateClash.date}</span>}
                  {r.applying ? <span className="tag tag-applied">logging…</span> : r.applied?.ok && <span className="tag tag-applied">applied</span>}
                  {r.status === 'running' ? `running ${elapsed(r.started)}` : r.status === 'queued' ? 'queued' : r.status === 'failed' ? 'failed' : when(r.finished || r.started)}
                </span>
              </span>
            </button>
          ))}
        </nav>
        <button className="btn btn-ghost side-foot" onClick={() => window.api.open('output')}>
          <Icon name="folder" /> Output folder
        </button>
      </aside>

      <main className="main">
        {run ? <RunDetail key={run.id} run={run} />
          : view === 'templates' ? <TemplatesView templates={templates} onRescan={() => window.api.templates(true).then(setTemplates)} />
          : view === 'settings' ? <SettingsView onSaved={recheck} />
          : view === 'setup' ? <SetupView checks={checks} onRecheck={recheck} go={setView} />
          : <Composer templates={templates} onQueued={(id) => setView({ run: id })} go={setView} />}
      </main>
    </div>
  )
}

const LAST = 'ct.template'
const MODE = 'ct.inputMode'
const AUTO = 'auto' // tailor.py --template auto: the agent picks the template
const RANK = { valid: 0, warnings: 1, invalid: 2 }
const remembered = () => { try { return localStorage.getItem(LAST) } catch { return null } }

function Composer({ templates, onQueued, go }: { templates: TemplateInfo[] | null; onQueued: (id: string) => void; go: (v: View) => void }) {
  const [jd, setJd] = useState('')
  const [links, setLinks] = useState('')
  const [jdLink, setJdLink] = useState('') // Paste mode: the posting's link, recorded with the run
  const [mode, setMode] = useState<'link' | 'paste'>(() => { try { return localStorage.getItem(MODE) === 'paste' ? 'paste' : 'link' } catch { return 'link' } })
  const [pick, setPick] = useState<string | null>(remembered)
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => ref.current?.focus(), [mode])
  const switchMode = (m: 'link' | 'paste') => { setMode(m); setErr(''); try { localStorage.setItem(MODE, m) } catch { /* private mode */ } }

  const usable = templates?.filter((t) => t.status !== 'invalid').sort((a, b) => RANK[a.status] - RANK[b.status]) ?? []
  const auto = pick === AUTO && usable.length > 1 // auto needs something to choose between
  const template = auto ? { path: AUTO } : usable.find((t) => t.path === pick) ?? usable[0]
  const choose = (p: string) => { setPick(p); try { localStorage.setItem(LAST, p) } catch { /* private mode */ } }

  const words = jd.trim() ? jd.trim().split(/\s+/).length : 0
  const urls = links.split(/\s+/).filter((u) => /^https?:\/\/\S+$/i.test(u))
  const ready = mode === 'link' ? urls.length > 0 : !!jd.trim()

  const submit = async () => {
    if (!ready || busy || !template) return
    setErr('')
    try {
      if (mode === 'paste') {
        setBusy('Queueing…')
        onQueued(await window.api.tailor(template.path, jd, jdLink.trim()))
        setJd('')
        setJdLink('')
        return
      }
      // Link mode: read each posting here; queue the ones that read, hand the first that didn't to Paste mode
      const failed: { url: string; error: string }[] = []
      const dupes: string[] = []
      let last = ''
      for (const [i, u] of urls.entries()) {
        setBusy(urls.length > 1 ? `Reading ${i + 1} of ${urls.length}…` : 'Reading the posting…')
        const f = await window.api.fetchPosting(u)
        if (f.tailored) dupes.push(f.tailored) // same job id as an earlier run: don't tailor it again
        else if (f.text) last = await window.api.tailor(template.path, `${u}\n\n${f.text}`, u)
        else failed.push({ url: u, error: f.error })
      }
      setLinks(failed.map((f) => f.url).join('\n'))
      if (failed.length) {
        setJdLink(failed[0].url)
        setJd('')
        switchMode('paste')
        setErr(`Couldn't read ${failed.length === 1 ? 'that page' : `${failed.length} of the links`} (${failed[0].error}). ` +
          `Paste the job description for ${failed[0].url}${failed.length > 1 ? '; the other failed links are still in the Link tab' : ''}.`)
      }
      if (dupes.length && !failed.length)
        setErr(`Already tailored (same job ID), skipped: ${dupes.join(', ')}. It's in the run list; ` +
          'to tailor it again anyway, use Paste.')
      if (last) onQueued(last)
    } catch (e) {
      setErr(errText(e))
    } finally {
      setBusy('')
    }
  }

  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.ctrlKey && e.key === 'Enter') { e.preventDefault(); submit() } }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  })

  return (
    <div className="page composer">
      <PageHead title="Tailor a resume" sub="Give a link to the posting (or paste its description) and pick a template. The agent rewrites only the Technical Skills section; you review every change here." />
      <div className="composer-grid">
        <div className="jd-card">
          <div className="jd-head">
            <span className="field-label">{mode === 'link' ? 'Posting links' : 'Job description'}</span>
            <div className="segmented" role="radiogroup" aria-label="Input">
              {(['link', 'paste'] as const).map((m) => (
                <button key={m} role="radio" aria-checked={mode === m} className={mode === m ? 'on' : ''} onClick={() => switchMode(m)}>
                  <Icon name={m === 'link' ? 'link' : 'file'} size={13} />{m === 'link' ? 'Link' : 'Paste'}
                </button>
              ))}
            </div>
          </div>
          {mode === 'link' ? (
            <>
              <textarea id="links" ref={ref} className="mono" value={links} onChange={(e) => setLinks(e.target.value)} spellCheck={false}
                placeholder={'https://jobs.example.com/posting/123\n\nOne link per line to tailor several at once. Workday, Greenhouse, Lever, Ashby, iCIMS, Oracle, and Microsoft careers pages are read directly; if a page can\'t be read, you\'ll paste its description instead.'} />
              <div className="jd-foot">
                <span>{urls.length ? `${urls.length} link${urls.length > 1 ? 's' : ''}` : 'Empty'}</span>
                {links && <button className="link" onClick={() => { setLinks(''); ref.current?.focus() }}>Clear</button>}
              </div>
            </>
          ) : (
            <>
              <input className="jd-link mono" value={jdLink} onChange={(e) => setJdLink(e.target.value)} spellCheck={false}
                placeholder="Posting link (optional, saved with the run)" aria-label="Posting link" />
              <textarea id="jd" ref={ref} value={jd} onChange={(e) => setJd(e.target.value)} spellCheck={false}
                placeholder="Paste the full posting: title, company, responsibilities, requirements…" />
              <div className="jd-foot">
                <span>{words ? `${words.toLocaleString()} words` : 'Empty'}</span>
                {jd && <button className="link" onClick={() => { setJd(''); ref.current?.focus() }}>Clear</button>}
              </div>
            </>
          )}
        </div>
        <div className="side-panel">
          <div className="field-label" id="tpl-label">Template</div>
          {templates === null ? <div className="tpl skeleton" />
            : !templates.length ? (
              <div className="empty-mini">
                <p>No templates yet.</p>
                <button className="link" onClick={() => go('templates')}>Add a template</button>
              </div>
            ) : (
              <div className="tpl-list" role="radiogroup" aria-labelledby="tpl-label">
                {usable.length > 1 && (
                  <button role="radio" aria-checked={auto} className={`tpl tpl-auto ${auto ? 'on' : ''}`} onClick={() => choose(AUTO)}
                    title="An extra agent call reads the posting and picks the best-fitting template">
                    <span className="tpl-icon" aria-hidden="true"><Icon name="wand" size={17} /></span>
                    <span className="tpl-text">
                      <span className="tpl-name">Auto</span>
                      <span className="tpl-file">Picks the best template for the posting</span>
                    </span>
                  </button>
                )}
                {[...templates].sort((a, b) => RANK[a.status] - RANK[b.status]).map((t) => {
                  const on = t.path === template?.path
                  const bad = t.status === 'invalid'
                  return (
                    <button key={t.path} role="radio" aria-checked={on} disabled={bad}
                      className={`tpl ${on ? 'on' : ''}`} onClick={() => choose(t.path)}
                      title={bad ? `Invalid: ${t.errors[0] ?? ''}` : t.path}>
                      <span className="tpl-icon" aria-hidden="true"><Icon name={tplIcon(t.icon)} size={17} /></span>
                      <span className="tpl-text">
                        <span className="tpl-name">{t.title}</span>
                        <span className="tpl-file mono">{t.file}</span>
                      </span>
                      {t.status !== 'valid' && <StatusBadge t={t} />}
                    </button>
                  )
                })}
              </div>
            )}
          {templates?.some((t) => t.status === 'invalid') && (
            <button className="link small" onClick={() => go('templates')}>Why are some templates disabled?</button>
          )}
          <button className="btn btn-primary btn-lg" disabled={!ready || !!busy || !template} onClick={submit}>
            {busy && <Icon name="spinner" className="spin" />}
            {busy || (mode === 'link' && urls.length > 1 ? `Tailor ${urls.length} resumes` : 'Tailor resume')}
            {!busy && <kbd>Ctrl ↵</kbd>}
          </button>
          {err && <div className="alert alert-danger" role="alert"><Icon name="alert" />{err}</div>}
          <ul className="notes">
            <li><Icon name="clock" size={14} />Takes 1–4 minutes. Up to 3 run at once; the rest queue.</li>
            <li><Icon name="shield" size={14} />Only Technical Skills may change; an integrity check verifies it.</li>
            <li><Icon name="folder" size={14} />The PDF is copied to your output folder.</li>
          </ul>
        </div>
      </div>
    </div>
  )
}
