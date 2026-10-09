import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { diffLines } from 'diff'
import type { Detail, Run } from '../shared/types'
import { Icon, Section, StatusPill, elapsed, templateName, when } from './ui'

export function RunDetail({ run }: { run: Run }) {
  const [d, setD] = useState<Detail | null>(null)
  const [err, setErr] = useState('')
  const [openErr, setOpenErr] = useState('')
  const [clicked, setClicked] = useState(false)
  const applying = clicked || !!run.applying
  const [applied, setApplied] = useState(run.applied)
  useEffect(() => setApplied(run.applied), [run.id, run.applied])
  useEffect(() => setClicked(false), [run.id]) // another run's click is not this one's; run.applying carries the truth
  const markApplied = async () => {
    setClicked(true)
    setOpenErr('')
    try {
      const a = await window.api.applied(run.id)
      setApplied(a)
      if (a && !a.ok) setOpenErr(`Marked applied, but logging it failed: ${a.error} (press Retry log)`)
    } catch (e) {
      setOpenErr(String((e as Error)?.message ?? e))
    }
    setClicked(false)
  }
  const unapply = async () => {
    setOpenErr('')
    try {
      await window.api.unapply(run.id)
      setApplied(undefined)
    } catch (e) {
      setOpenErr(String((e as Error)?.message ?? e))
    }
  }
  const finished = run.status === 'done' || run.status === 'failed'

  useEffect(() => {
    if (!finished) return
    setD(null)
    window.api.detail(run.id).then(setD, (e) => setErr(String(e?.message ?? e)))
  }, [run.id, finished])

  const open = async (t: 'pdf' | 'folder' | 'log' | 'posting' | 'applied') => setOpenErr(await window.api.open(t, run.id))

  return (
    <div className="detail">
      <header className="detail-head">
        <div className="detail-title">
          <div className="eyebrow">
            <StatusPill r={run} />
            <span className="tag tag-lg" title={run.template}>{run.auto && <Icon name="wand" size={12} />}{templateName(run.template)}</span>
          </div>
          <h1>{run.company || run.title || 'Untitled posting'}</h1>
          {run.role && <p className="role">{run.role}</p>}
          <p className="times">
            {run.started && <><Icon name="clock" size={13} />{when(run.started)}</>}
            {run.finished && <> <Icon name="arrow" size={12} /> {when(run.finished)} · took {elapsed(run.started, run.finished)}</>}
            <span className="mono dim">{run.started ? '· ' : 'run '}{run.id}</span>
          </p>
          {run.auto && <p className="auto-note"><Icon name="wand" size={13} />Auto picked <b>{templateName(run.template)}</b>{run.auto_reason ? `: ${run.auto_reason}` : ''}</p>}
        </div>
        <div className="actions">
          <button className="btn btn-primary" disabled={!run.output && !run.pdf && !run.folder} onClick={() => open('pdf')}><Icon name="file" />Open PDF</button>
          {run.status === 'done' && (applied?.ok
            ? <>
                <button className="btn btn-applied" onClick={() => applied.link && open('applied')} title={applied.link ? 'Open the logged entry' : 'Marked applied'}><Icon name="check" />Applied {applied.date}{applied.link && <Icon name="external" size={12} />}</button>
                <button className="btn" onClick={unapply} title="Clicked Applied by mistake: clear the mark so you can press Applied again later. Delete the logged entry (e.g. the Notion row) yourself.">Undo</button>
              </>
            : <button className="btn" disabled={applying} onClick={markApplied} title="You applied: mark it, and log it where Settings says (e.g. your Notion table)">
                <Icon name={applying ? 'spinner' : 'check'} className={applying ? 'spin' : undefined} />{applying ? 'Logging…' : applied ? 'Retry log' : 'Applied'}</button>)}
          <button className="btn" disabled={!run.output && !run.pdf && !run.folder} onClick={() => open('folder')} title="Opens the output folder with this PDF selected"><Icon name="folder" />Show in folder</button>
          <button className="btn" disabled={!run.url} onClick={() => open('posting')} title={run.url || 'No posting link recorded for this run'}><Icon name="link" />Open posting</button>
          <button className="btn" onClick={() => window.api.open('output')}><Icon name="folder" />Output folder</button>
        </div>
      </header>
      {openErr && <div className="alert alert-danger"><Icon name="alert" />{openErr}</div>}

      {!finished && (
        <div className="card progress-card">
          <div className="progress-top">
            <Icon name="spinner" size={20} className="spin accent" />
            <div>
              <h3>{run.status === 'queued' ? 'Waiting for a free slot' : 'Tailoring this resume'}</h3>
              <p className="dim">Reading the posting, writing job.md, editing Technical Skills, rendering a one-page PDF. Usually 1–4 minutes.</p>
            </div>
            <div className="big-timer mono">{run.status === 'running' ? elapsed(run.started) : '–:––'}</div>
          </div>
          <div className="bar"><span /></div>
        </div>
      )}

      {run.status === 'failed' && (
        <div className="alert alert-danger alert-block" role="alert">
          <Icon name="alert" size={18} />
          <div>
            <strong>Run failed</strong>
            <pre className="err-text">{run.error || 'No error message recorded.'}</pre>
          </div>
          <button className="btn btn-sm" onClick={() => open('log')}><Icon name="log" />Open log</button>
        </div>
      )}

      {err && <div className="alert alert-danger"><Icon name="alert" />{err}</div>}
      {finished && !d && !err && <div className="card skeleton tall" />}
      {d && <Review run={run} d={d} />}
    </div>
  )
}

function Review({ run, d }: { run: Run; d: Detail }) {
  const a = d.ats
  const adj = run.new_adjacent ?? []
  const gaps = run.gaps ?? []
  return (
    <>
      {d.resume === null || !a ? (run.status === 'failed' ? null :
        <div className="alert alert-muted"><Icon name="alert" />No resume.md in the run folder, so there is nothing to diff.</div>
      ) : a.ok ? (
        <>
          <div className="integrity ok">
            <span className="integrity-icon"><Icon name="shield" size={18} /></span>
            <div>
              <strong>Only Technical Skills changed{run.redacted?.length ? ', plus the redaction below' : ''} ✓</strong>
              <p>resume.py ats compared resume.md to the {d.atsAgainst === 'snapshot' ? 'template as it was at run time' : 'current template'}: every other section is identical and every skill is in your skills file.</p>
            </div>
          </div>
          {!!run.redacted?.length && (
            <div className="integrity redacted">
              <span className="integrity-icon"><Icon name="pen" size={18} /></span>
              <div>
                <strong>Redacted: {run.redacted.join(', ')}</strong>
                <p>{run.company} asks U.S. applicants to remove dates of attendance at or graduation from school, so the
                  date on each Education entry was removed. It shows as a changed Education line in the full diff below;
                  the integrity check allows exactly this change and nothing else.</p>
              </div>
            </div>
          )}
        </>
      ) : run.custom?.length ? (
        <div className="integrity redacted">
          <span className="integrity-icon"><Icon name="pen" size={18} /></span>
          <div>
            <strong>Custom resume: deviates from the template on purpose</strong>
            <ul>{run.custom.map((c) => <li key={c}>{c}</li>)}</ul>
            {!!run.redacted?.length && <p>Also redacted: {run.redacted.join(', ')}.</p>}
            <p>The integrity check flags exactly these: {a.errors.join('; ')}. Every change shows in the full diff below.</p>
          </div>
        </div>
      ) : (
        <div className="integrity bad" role="alert">
          <span className="integrity-icon"><Icon name="alert" size={18} /></span>
          <div>
            <strong>Integrity check failed: more than Technical Skills may have changed</strong>
            <ul>{a.errors.map((e) => <li key={e}>{e}</li>)}</ul>
          </div>
        </div>
      )}

      {(a?.ok || !!run.custom?.length) && a && (
        <Section title="Skill changes" icon="code">
          <div className="chip-rows">
            <ChipRow label="Added" items={a.added} kind="add" />
            <ChipRow label="Dropped" items={a.dropped} kind="drop" />
          </div>
          {a.reorders.length > 0 && (
            <div className="reorders">
              <div className="mini-label">Order per line</div>
              {a.reorders.map((r) => {
                const same = r.before.join() === r.after.join()
                return (
                  <div key={r.label} className={`reorder ${same ? 'same' : ''}`}>
                    <span className="reorder-label">{r.label}</span>
                    <div className="reorder-lines">
                      <span className="chips"><span className="ro-tag">before</span>{r.before.map((s) => <span key={s} className={`chip ${r.after.includes(s) ? 'chip-plain' : 'chip-drop'}`}>{s}</span>)}</span>
                      {same ? <span className="dim small">unchanged</span> : <span className="chips"><span className="ro-tag">after</span>{r.after.map((s) => <span key={s} className={`chip ${r.before.includes(s) ? 'chip-plain' : 'chip-add'}`}>{s}</span>)}</span>}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </Section>
      )}

      {(adj.length > 0 || gaps.length > 0 || run.status === 'done') && (
        <div className="two-col">
          <Section title="New adjacent skills" icon="alert">
            {adj.length ? (
              <>
                <p className="note-amber">From the Adjacent list in your skills file. Make sure you'd defend these in an interview.</p>
                <div className="adj-list">
                  {adj.map((s) => (
                    <div key={s} className="adj">
                      <span className="chip chip-amber">{s}</span>
                      <span className="adj-near">{d.near[s] ? <>near: {d.near[s]}</> : <span className="dim">no near: note in the skills file</span>}</span>
                    </div>
                  ))}
                </div>
              </>
            ) : <p className="dim small">None. Every added skill is one you already list.</p>}
          </Section>
          <Section title="Gaps (not listed)" icon="x">
            {gaps.length
              ? <div className="chips">{gaps.map((g) => <span key={g} className="chip chip-gray">{g}</span>)}</div>
              : <p className="dim small">No gaps reported.</p>}
          </Section>
        </div>
      )}

      {d.template !== null && d.resume !== null && (
        <Section title="Full diff" icon="code" aside={<span className="dim small">template{d.atsAgainst === 'snapshot' ? ' (run-time snapshot)' : ''} → resume.md</span>}>
          <LineDiff a={d.template} b={d.resume} />
        </Section>
      )}

      {d.keywords && (
        <details className="card fold">
          <summary><Icon name="chevron" size={14} className="caret" />Posting keywords <span className="dim small">job.md</span></summary>
          <ul className="kw">
            {d.keywords.split('\n').filter((l) => l.startsWith('- ')).map((l) => {
              const [name, ...rest] = l.slice(2).split(' · ')
              const gap = rest[0]?.startsWith('gap')
              return (
                <li key={l}>
                  <span className={`kw-dot ${gap ? 'gap' : 'have'}`} aria-hidden="true" />
                  <span className="kw-name">{name}</span>
                  <span className="dim">{rest.join(' · ')}</span>
                </li>
              )
            })}
          </ul>
        </details>
      )}
      {d.changes && (
        <details className="card fold">
          <summary><Icon name="chevron" size={14} className="caret" />changes.md <span className="dim small">the agent's summary</span></summary>
          <pre className="md">{d.changes}</pre>
        </details>
      )}
    </>
  )
}

function ChipRow({ label, items, kind }: { label: string; items: string[]; kind: 'add' | 'drop' }) {
  return (
    <div className="chip-row">
      <span className="mini-label">{label}</span>
      <span className="chips">
        {items.length ? items.map((s) => (
          <span key={s} className={`chip chip-${kind}`}>{kind === 'add' ? '+' : '−'} {s}</span>
        )) : <span className="dim small">none</span>}
      </span>
    </div>
  )
}

type Line = { t: ' ' | '+' | '-'; text: string; o?: number; n?: number }
const CONTEXT = 3

function LineDiff({ a, b }: { a: string; b: string }) {
  const lines = useMemo(() => {
    const out: Line[] = []
    let o = 1, n = 1
    for (const part of diffLines(a, b)) {
      const ls = part.value.replace(/\n$/, '').split('\n')
      for (const text of ls) {
        if (part.added) out.push({ t: '+', text, n: n++ })
        else if (part.removed) out.push({ t: '-', text, o: o++ })
        else out.push({ t: ' ', text, o: o++, n: n++ })
      }
    }
    return out
  }, [a, b])
  const [expanded, setExpanded] = useState<Set<number>>(new Set())

  if (!lines.some((l) => l.t !== ' ')) return <p className="dim small">resume.md is identical to the template.</p>

  // visible = within CONTEXT lines of a change; contiguous hidden runs collapse into one expander row
  const near = lines.map(() => false)
  lines.forEach((l, i) => {
    if (l.t === ' ') return
    for (let j = Math.max(0, i - CONTEXT); j <= Math.min(lines.length - 1, i + CONTEXT); j++) near[j] = true
  })
  const rows: ReactNode[] = []
  for (let i = 0; i < lines.length;) {
    if (near[i] || expanded.has(i)) {
      const l = lines[i]
      rows.push(
        <div key={i} className={`dl dl-${l.t === '+' ? 'add' : l.t === '-' ? 'del' : 'ctx'}`}>
          <span className="ln">{l.o ?? ''}</span><span className="ln">{l.n ?? ''}</span>
          <span className="sign">{l.t}</span><span className="code">{l.text || ' '}</span>
        </div>,
      )
      i++
      continue
    }
    const start = i
    while (i < lines.length && !near[i] && !expanded.has(i)) i++
    const count = i - start
    rows.push(
      <button key={`gap${start}`} className="dl-gap" onClick={() => setExpanded(new Set([...expanded, ...Array.from({ length: count }, (_, k) => start + k)]))}>
        <Icon name="chevron" size={12} className="rot90" /> {count} unchanged line{count === 1 ? '' : 's'}
      </button>,
    )
  }
  return <div className="difftable mono">{rows}</div>
}
