# Career Tailor

Paste a job description, pick your resume template, and a coding agent rewrites only the Technical Skills section
to match the posting for ATS filters. You get a one-page PDF and a diff you can audit.

![Career Tailor](docs/screenshot.png)

Only Technical Skills changes. Your bullets, dates, and contact info are never touched, and every run is checked
against your template to prove it.

## How it works

```
job description + your template.md + skills.md
        |
        v
  validate template  -->  coding agent (Claude Code)
                          reorders / adds skills from your allowlist
        |
        v
  ATS check: nothing but Technical Skills changed, no unlisted skills
        |
        v
  render with LaTeX (Tectonic)  -->  one-page Letter PDF
        |
        v
  output folder: PDF  +  run history with a diff against your template
```

## Download

Windows: download the installer from [GitHub Releases](https://github.com/danmano411/career-tailor/releases)
(`Career-Tailor-Setup-<version>.exe`).

macOS: download `Career-Tailor-<version>-arm64.dmg` (Apple Silicon) or `-x64.dmg` (Intel) from
[GitHub Releases](https://github.com/danmano411/career-tailor/releases). The app is not notarized, so the first time,
right-click it in Applications → Open, or run `xattr -cr "/Applications/Career Tailor.app"`.

Linux: no prebuilt binary yet, [build from source](#build-from-source).

## Requirements

- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code), installed and logged in (`claude --version` works)
- Python 3.10+ on your PATH
- Tectonic (LaTeX engine): downloaded automatically on first run from the setup screen, or use one already on PATH

## Setup

1. Install Claude Code and log in, and install Python 3.10+.
2. Run the Career Tailor installer and open the app.
3. The setup checklist shows what is missing. Click Install next to Tectonic if it is not found.
4. Open Settings and choose your templates, output, and runs folders (defaults are under
   `Documents/Career Tailor/`; the example template and its `skills.md` are copied in on first run).
5. Add your own template to the templates folder: either write it by hand using the
   [template format](docs/TEMPLATE_FORMAT.md), or give your PDF/DOCX resume to a coding agent with the
   copy-paste prompt in that doc ("Convert your existing resume"). Click Re-scan.

## Usage

1. Pick a valid template (the status shows a check, warnings, or errors), or pick **Auto**: with two or more
   templates, one extra agent call reads the posting and chooses the best fit (e.g. an ML role at a self-driving
   company goes to your ML template, a SLAM role to your robotics one). The run page shows what it picked and why.
2. **Link** (default): put in the posting link, or several, one per line. Workday, Greenhouse, Lever, Ashby, iCIMS,
   Oracle and Microsoft careers pages are read directly. If a page can't be read, the app switches to **Paste** with
   that link kept for the run: paste the description and press Ctrl+Enter. Up to 3 runs go at once.
3. When a run finishes, open it for the diff: integrity badge, added/dropped/reordered skills, adjacent and gap
   skills, the line diff against your template, job keywords, and the agent's notes.
4. The PDF is saved in your output folder named with your file name format.

Skills the agent may use come from your skills file (`## Skills` and `## Adjacent`, see
[template format](docs/TEMPLATE_FORMAT.md)). If you do not set one, `skills.md` in your templates folder is used,
and created from your template if that file does not exist.

## Applied button

When you apply to a job, press **Applied** on its run page. The run is marked applied (it shows in the list), and if
Settings → "When I press Applied" has an instruction, the agent carries it out with the job's company, role, posting
link and today's date: for example, add a row to a Notion Applications database using your Claude Notion connector
(set "Tools for that" to `mcp__claude_ai_Notion`). It checks for an existing entry first, so pressing twice doesn't
duplicate. Nothing is logged when a resume is only tailored.

## Job scan routine

Career Tailor can scan job boards twice a day by itself: it collects the postings that are new since the last scan,
an agent reads each one and judges eligibility and fit against your profile, the matches are tailored (Auto
template), and a report lands in `reports/<date>/` next to your runs folder (PDFs in `<output>/<date>/`) with a Windows
notification.

- Turn it on: tray icon → **Routine settings…** opens `routine.json`. Set `"enabled": true` and write your
  `profile` (school, graduation date, class standing, work authorization, target roles, locations). The screener
  judges eligibility from it, so be specific.
- When: `slots` are time windows (default 11:45–14:30 and 18:00–21:00). Each runs once a day, at the first check
  inside its window, so a laptop that was asleep at noon still scans when it wakes.
- What counts as new: a diff, not a date filter. Each board is compared with its rows at the last successful
  fetch (boards backdate posting dates, so dates miss real additions). A failed fetch keeps the old snapshot, so
  an outage delays postings but never skips them. The first fetch of a board records a baseline and screens only the postings the board dates within the last
  day (`backfill_hours`, default 24; SimplifyJobs-style lists and Early Career Radar have dates). A job already
  tailored, by a scan or by you in the app, is never tailored again (matched by job id).
- Where from: `sources`. `listings-json` (SimplifyJobs-style repos; optional `mirror`, e.g.
  `https://simplify.jobs/p/{id}`, a readable copy for career sites that need JavaScript), `markdown` (any README
  with `| [Name](link) | ... |` tables), `earlycareerradar`, plus `web_search` (an agent searches for recent
  postings the boards missed).
- What gets tailored: every readable posting that isn't ruled out by a hard requirement and scores at least
  `min_fit` (1–5, default 3; set 1 to tailor everything you are eligible for and decide yourself). "Uncertain" ones (e.g. an unknown GPA minimum) are tailored too and flagged in the
  report. Postings the agent couldn't read get their own section with links, to check by hand.
- Limits: `max_candidates` screened per scan (the rest wait for the next scan), optional `max_tailor`, `parallel`
  (agent calls at once, default 3).
- With the routine on, Career Tailor starts at login (in the tray, no window) and closing the window keeps it
  running. Clicking the shortcut again opens the window. Stop it from Task Manager, or set `"startup": false`.

The routine runs your agent unattended with web access (WebFetch, WebSearch) and the same tools a manual run uses,
so each scan uses agent credits: about one call per 5 postings screened, plus one per tailored resume.

## Settings

| Setting | Default | Notes |
|---------|---------|-------|
| Templates folder | `Documents/Career Tailor/templates` | `*.md` templates, watched for changes |
| Output folder | `Documents/Career Tailor/output` | Finished PDFs |
| Runs folder | `Documents/Career Tailor/runs` | One folder per run with `run.json` |
| Skills file | `<templates folder>/skills.md` | Optional allowlist; created from the template if the file does not exist |
| Python path | `python` (Windows), `python3` (macOS/Linux) | Interpreter used to run the backend |
| Agent | `claude` | Claude Code CLI |
| Model | `sonnet` | Passed to the agent |
| File name format | `{name} Resume - {company} {role}` | Output PDF name |

## Privacy

Everything runs on your machine. Your templates, job descriptions, runs, and PDFs stay in the folders you chose.
The job description and your template are sent to your coding agent provider (Anthropic, via your Claude Code
login) and nowhere else. Other network use: the one-time Tectonic download, the LaTeX packages Tectonic fetches on
first render, and the posting page itself if you paste only a URL.

## Build from source

```
cd app
npm install
npm run build
npm run package     # Windows installer in app/dist
npm run package:mac # macOS .dmg and .zip (arm64 + x64) in app/dist
```

Backend tests:

```
python backend/resume.py --test
python backend/render.py --test
python backend/tailor.py --test
```

Command line, without the app:

```
python backend/resume.py validate examples/templates/example-swe.md
python backend/tailor.py --template <template.md> --jd-file <jd.txt> --work-dir <dir> --out-dir <dir>
```

## Roadmap

- Codex CLI backend
- Direct LLM API backend (no coding agent needed)
- macOS build
- More LaTeX layouts

## Troubleshooting

- **PDF will not re-render**: the old PDF is open in a viewer that locks the file. Close it and run again.
- **Template shows errors**: run `python backend/resume.py validate <file>` or read the reasons on the card. Common
  causes: no `## Technical Skills` section, skill lines not shaped like `**Label** – a, b`, or a bullet before any
  `###` entry. See [template format](docs/TEMPLATE_FORMAT.md).
- **`claude` not found**: install Claude Code, log in, and make sure `claude --version` works in a new terminal, then
  restart the app so it picks up PATH.
- **Template is over one page**: shorten bullets or drop an entry; the app will not trim it for you.

## License

[MIT](LICENSE)
