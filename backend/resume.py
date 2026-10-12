"""Resume tools for the Career Tailor markdown dialect. Every command prints one JSON object on its last stdout line
(exit 0 ok, 1 failure).

  python resume.py validate <template.md> [--render]       # dialect + structure check; --render also checks 1 page
  python resume.py ats <template.md> <resume.md> --skills <skills.md> [--redact] [--grad "Dec 2028"]
                         # only Technical Skills may differ (--redact: Education dates may be removed, see redact();
                         # --grad: the Education date is that earlier graduation date, see regrad())
  python resume.py sync <name[.md|.txt]>                   # fuse a .md/.txt pair: newer mtime is copied over the other
  python resume.py --test

Dialect: "# Name", contact lines, "## Section", "### Entry || Date", "- bullet" (only under an entry), other lines
are paragraphs. Skill lines (under "## Technical Skills") look like "**Label** – a, b, c". **bold**, *italic*.
Skills file: "## Skills" and "## Adjacent" sections of "- <Skill> · <note>" lines (note optional).
"""
import json, pathlib, re, shutil, sys

SLOP = ["leverag", "spearhead", "utiliz", "synerg", "cutting-edge", "seamless", "robust", "delve",
        "passionate", "dynamic", "innovative", "state-of-the-art", "world-class", "best-in-class",
        "empower", "orchestrat", "revolutioniz", "game-chang", "holistic", "streamlin", "fostering"]
SKILL = re.compile(r"^\*\*(.+?)(?::\*\*|\*\*\s*[–:-])\s*(.+)$")
SKILLS = "Technical Skills"


def parse(md):
    """-> {'head': [lines], 'sections': [(name, [block])]}; block = ('entry', text, [bullets]) | ('para', text)."""
    doc = {"head": [], "sections": []}
    for line in md.strip().splitlines():
        line = line.rstrip()
        if not line:
            continue
        if line.startswith("## "):
            doc["sections"].append((line[3:].strip(), []))
        elif not doc["sections"]:
            doc["head"].append(line)
        elif line.startswith("### "):
            doc["sections"][-1][1].append(("entry", line[4:], []))
        elif line.startswith("- "):
            blocks = doc["sections"][-1][1]
            if not blocks or blocks[-1][0] != "entry":
                raise ValueError(f"bullet outside an entry: {line[:60]}")
            blocks[-1][2].append(line[2:])
        else:
            doc["sections"][-1][1].append(("para", line))
    return doc


def plain(s):
    return re.sub(r"\*+", "", s)


def has_slop(s):
    s = s.lower()
    return [w for w in SLOP if re.search(r"\b" + w, s)]  # word-start match: "thermodynamically" is not "dynamic"


def read(p):
    return pathlib.Path(p).read_text(encoding="utf-8-sig").replace("\r\n", "\n")


def emit(obj, ok=True):
    print(json.dumps(obj, ensure_ascii=False))
    sys.exit(0 if ok else 1)


# ---------- validate ----------

def validate(text):
    """text -> result dict. Errors block a run; warnings do not."""
    errs, warns = [], []
    res = {"ok": False, "errors": errs, "warnings": warns, "name": "", "sections": [], "skill_labels": [], "skills": []}
    if not text.strip():
        errs.append("file is empty")
        return res
    lines = text.replace("\r\n", "\n").split("\n")
    first = next((i for i, l in enumerate(lines) if l.strip()), 0)
    if lines[first].startswith("# "):
        res["name"] = lines[first][2:].strip()
    else:
        errs.append(f"line {first + 1}: first line must be '# Your Name'")
    sec, entry, skills_sec = None, False, None
    for n, raw in enumerate(lines, 1):
        line = raw.rstrip()
        if not line or n == first + 1:
            continue
        if line.startswith("## "):
            sec, entry = line[3:].strip(), False
            res["sections"].append(sec)
            if sec.lower() == SKILLS.lower():
                skills_sec = sec
                if sec != SKILLS:
                    warns.append(f"line {n}: section '{sec}' should be spelled '{SKILLS}'")
        elif sec is None:
            continue  # contact lines
        elif line.startswith("### "):
            entry = True
            if "||" not in line:
                warns.append(f"line {n}: entry has no '|| date' (expected '### Title || Dates')")
        elif sec.lower() == SKILLS.lower():
            m = SKILL.match(line)
            if m:
                items = [i.strip() for i in m.group(2).split(",") if i.strip()]
                res["skill_labels"].append(m.group(1))
                res["skills"] += items
            else:
                errs.append(f"line {n}: skill line must look like **Label** – a, b, c (got: {line[:50]!r})")
        elif line.startswith("- "):
            if not entry:
                errs.append(f"line {n}: bullet outside an entry; put a '### Title || Dates' line above it")
            for w in has_slop(line):
                warns.append(f"line {n}: filler word '{w}'")
    if not res["sections"]:
        errs.append("no '## ' sections found (e.g. '## Education', '## Technical Skills')")
    if not skills_sec:
        errs.append(f"no '## {SKILLS}' section; the tailor only edits that section, so it is required")
    elif not res["skill_labels"] and not any("skill line" in e for e in errs):
        errs.append(f"'## {SKILLS}' has no skill lines; add lines like **Languages** – Python, C++")
    flat = res["skills"]
    warns += [f"duplicate skill: {i}" for i in sorted({i for i in flat if flat.count(i) > 1})]
    if not errs:
        warns += [f"repeated opener: {w}" for w in repeated_openers(text)]
    res["ok"] = not errs
    return res


def validate_file(path):
    try:
        raw = pathlib.Path(path).read_bytes()
    except OSError as ex:
        return {"ok": False, "errors": [f"cannot read {path}: {ex.strerror or ex}"], "warnings": [], "name": "",
                "sections": [], "skill_labels": [], "skills": []}
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError as ex:
        return {"ok": False, "errors": [f"file is not UTF-8 (byte {ex.start}); re-save it as UTF-8"], "warnings": [],
                "name": "", "sections": [], "skill_labels": [], "skills": []}
    return validate(text)


# ---------- skills file ----------

def parse_skills(text):
    """-> ({skill: note}, {skill: note}). '## Adjacent' lines are the adjacent tier; every other '## ' section counts as
    skills (so '## Languages' / '## Tools' layouts work), except sections whose title says 'domain', 'not listed',
    'concept', 'technique' or 'ignore' (notes, or read by concepts() / techniques())."""
    out, cur = {"skills": {}, "adjacent": {}}, None
    for line in text.replace("\r\n", "\n").splitlines():
        if line.startswith("## "):
            title = line[3:].strip().lower()
            cur = None if any(w in title for w in ("domain", "not listed", "concept", "technique", "ignore")) else \
                "adjacent" if title.startswith("adjacent") else "skills"
        elif line.startswith("- ") and cur:
            name, _, note = line[2:].partition(" · ")
            out[cur][name.strip()] = note.strip()
    return out["skills"], out["adjacent"]


ADJ_KINDS = ("same as", "part of", "describes", "named in")  # see prompts/skill-rules.md


def concepts(text):
    """'## Concepts' lines, '- Data Visualization -> Matplotlib, Seaborn' (or '→'): broad terms (a field, practice, or
    activity) that Technical Skills never lists; the tools after the arrow are what to list instead. -> {concept: tools}"""
    out, on = {}, False
    for line in text.replace("\r\n", "\n").splitlines():
        if line.startswith("## "):
            on = "concept" in line.lower()
        elif on and line.startswith("- "):
            name, _, tools = line[2:].replace("→", "->").partition("->")
            out[name.strip()] = tools.strip()
    return out


def techniques(text):
    """'## Techniques (only on: ML/AI)' lines, '- Deep Learning · evidence': a field-specific technique, allowed but only
    on the skill line whose label contains the text after 'only on:'. -> {technique: label}"""
    out, label = {}, None
    for line in text.replace("\r\n", "\n").splitlines():
        if line.startswith("## "):
            m = re.search(r"technique.*only on:\s*([^)]+)", line, re.I)
            label = m.group(1).strip() if m else None
        elif label and line.startswith("- "):
            out[line[2:].partition(" · ")[0].strip()] = label
    return out


def misplaced(new_md, placement):
    """Techniques on the wrong skill line. placement: techniques() -> ["Deep Learning: ... ML/AI line"]"""
    where = {k.lower(): v for k, v in placement.items()}
    return [f"{i} is a technique, not a tool: it goes on the {where[i.lower()]} line, not {lab}"
            for lab, items in skill_lines(parse(new_md)).items() for i in items
            if i.lower() in where and where[i.lower()].lower() not in lab.lower()]


def allowed_skills(text):
    """-> (skills a resume may list, {skill: why it's refused}). An '## Adjacent' entry counts only when its note
    declares one of ADJ_KINDS with evidence ("- C · part of: C++ work"); "near:", "sibling", etc. don't. A '## Concepts'
    term is refused wherever else it appears (any case): the resume lists the tool instead. '## Techniques' entries
    are allowed (where they may go: misplaced())."""
    sk, adj = parse_skills(text)
    ok, refused = set(sk) | set(techniques(text)), {}
    for name, note in adj.items():
        kind, _, evidence = note.partition(":")
        if kind.strip().lower() in ADJ_KINDS and evidence.strip():
            ok.add(name)
        else:
            refused[name] = f"Adjacent entry must be '{name} · <{' | '.join(ADJ_KINDS)}>: <evidence>' (has {note!r})"
    con = {c.lower(): (c, tools) for c, tools in concepts(text).items()}
    for name in [*ok, *(c for c, _ in con.values())]:
        if name.lower() in con:
            ok.discard(name)
            c, tools = con[name.lower()]
            refused[name] = f"{name} is a concept, not a tool: list {tools or 'the tool that did the work'} instead"
    return ok, refused


def skills_from_template(template_md):
    """Seed text for a skills file: every skill in the template's skill lines."""
    items = []
    for lab, its in skill_lines(parse(template_md)).items():
        items += [i for i in its if i not in items]
    return "## Skills\n" + "".join(f"- {i}\n" for i in items) + "\n## Adjacent\n"


# ---------- ats ----------

def skill_lines(doc):
    """-> {label: [items]} for the Technical Skills section."""
    blocks = next((b for s, b in doc["sections"] if s.lower() == SKILLS.lower()), [])
    return {m.group(1): [i.strip() for i in m.group(2).split(",")] for b in blocks if b[0] == "para"
            for m in [SKILL.match(b[1])] if m}


def redact(md):
    """Drop the dates from Education entries ("### **School**, City || May 2029" -> "### **School**, City"). Some
    employers (Microsoft, for U.S. applicants) ask you to remove dates of attendance at or graduation from school."""
    out, sec = [], ""
    for line in md.split("\n"):
        if line.startswith("## "):
            sec = line[3:].strip().lower()
        if sec == "education" and line.startswith("### ") and "||" in line:
            line = line.split("||")[0].rstrip()
        out.append(line)
    return "\n".join(out)


MONTHS = "jan feb mar apr may jun jul aug sep oct nov dec".split()
SEASONS = {"spring": 5, "summer": 8, "fall": 12, "autumn": 12, "winter": 12}


def month_year(s):
    """"May 2029" / "December 2028" / "Fall 2028" -> (2029, 5); a bare "2028" -> (2028, 12), the whole year. None if
    there's no year."""
    s = (s or "").lower()
    y = re.search(r"\b(20\d\d)\b", s)
    if not y:
        return None
    m = next((i + 1 for i, mon in enumerate(MONTHS) if re.search(rf"\b{mon}", s)), None)
    m = m or next((v for k, v in SEASONS.items() if k in s), 12)
    return int(y.group(1)), m


def regrad(md, date):
    """Education entries' dates -> date. For a posting that requires graduating by a date the resume's (planned) date
    misses but an earlier possible one meets: declared in the run, and the ats check allows exactly this change."""
    out, sec = [], ""
    for line in md.split("\n"):
        if line.startswith("## "):
            sec = line[3:].strip().lower()
        if sec == "education" and line.startswith("### ") and "||" in line:
            line = f"{line.split('||')[0].rstrip()} || {date}"
        out.append(line)
    return "\n".join(out)


def edu_date(md):
    """The first Education entry's date ("May 2029"), or ""."""
    old, new = md.split("\n"), regrad(md, "\0").split("\n")
    return next((o.split("||")[1].strip() for o, n in zip(old, new) if n.endswith("\0")), "")


def use_early_grad(template_md, early, grad_by):
    """-> True when the posting's latest accepted graduation (grad_by: "2028", "Dec 2028") is before the template's
    date and the early date meets it. "Spring 2028" max is not met by Dec 2028, so nothing changes there."""
    planned, soon, limit = month_year(edu_date(template_md)), month_year(early), month_year(grad_by)
    return bool(planned and soon and limit) and soon <= limit < planned


def ats(template_md, new_md, allowed, redacted=False, refused=None, placement=None, grad=None):
    """-> (errors, added, dropped, reorders). Everything but Technical Skills must equal the template (with its
    Education dates removed when redacted: the one other change a resume may carry, declared, never silent).
    placement (techniques()): a technique must sit on its line."""
    template_md = regrad(template_md, grad) if grad else template_md
    t, n, errs = parse(redact(template_md) if redacted else template_md), parse(new_md), []
    if t["head"] != n["head"]:
        errs.append("header/contact lines changed")
    if [s.lower() for s, _ in t["sections"]] != [s.lower() for s, _ in n["sections"]]:
        return errs + ["sections added, removed, or reordered"], [], [], []
    for (sec, tb), (_, nb) in zip(t["sections"], n["sections"]):
        if sec.lower() != SKILLS.lower() and tb != nb:
            errs.append(f"{sec}: changed (only {SKILLS} may differ from the template)")
    ts, ns = skill_lines(t), skill_lines(n)
    if sorted(ts) != sorted(ns):
        errs.append(f"skill labels must stay {sorted(ts)}")
    flat = [i for items in ns.values() for i in items]
    errs += [f"duplicate skill: {i}" for i in sorted({i for i in flat if flat.count(i) > 1})]
    errs += [(refused or {}).get(i, f"not in skills file: {i}") for i in flat if i not in allowed]
    errs += misplaced(new_md, placement or {})
    old = [i for items in ts.values() for i in items]
    added, dropped = [i for i in flat if i not in old], [i for i in old if i not in flat]
    reorders = [{"label": lab, "before": ts.get(lab, []), "after": items} for lab, items in ns.items()
                if ts.get(lab) != items]
    return errs, added, dropped, reorders


def repeated_openers(md):
    """Bullets in one section that start with the same word ("Built" twice reads lazy)."""
    out = []
    for sec, blocks in parse(md)["sections"]:
        words = [plain(b).split()[0].lower() for blk in blocks if blk[0] == "entry" for b in blk[2] if plain(b).strip()]
        out += [f"{sec}: {w!r} opens {words.count(w)} bullets" for w in sorted(set(words)) if words.count(w) > 1]
    return out


# ---------- .md / .txt pair ----------

def sync(path):
    """Make <name>.md and <name>.txt identical (newer mtime wins, missing one is created). -> status string."""
    base = pathlib.Path(path)
    if base.suffix in (".md", ".txt"):
        base = base.with_suffix("")
    md, txt = base.with_suffix(".md"), base.with_suffix(".txt")
    if not md.exists() and not txt.exists():
        raise ValueError(f"neither {md} nor {txt} exists")
    if md.exists() != txt.exists():
        src, dst = (md, txt) if md.exists() else (txt, md)
    elif read(md) == read(txt):
        return "in sync"
    elif md.stat().st_mtime == txt.stat().st_mtime:
        raise ValueError(f"{md.name} and {txt.name} differ but have the same mtime; edit one and retry")
    else:
        src, dst = (md, txt) if md.stat().st_mtime > txt.stat().st_mtime else (txt, md)
    shutil.copy2(src, dst)
    return f"{src.suffix[1:]} -> {dst.suffix[1:]} (copied {src.name} over {dst.name})"


# ---------- selftest ----------

GOOD = """# Alex Rivera
alex@example.com | Springfield

## Work Experience
### **Engineer**, Acme || 2025
- Trained 20 networks in PyTorch

## Technical Skills
**Lang** – Python, C++
**Tools** – Git
"""


def selftest():
    import os, tempfile
    # validate
    r = validate(GOOD)
    assert r["ok"] and r["name"] == "Alex Rivera" and r["skill_labels"] == ["Lang", "Tools"], r
    assert r["skills"] == ["Python", "C++", "Git"] and r["sections"] == ["Work Experience", "Technical Skills"]
    r = validate(GOOD.replace("## Technical Skills\n**Lang** – Python, C++\n**Tools** – Git\n", ""))
    assert not r["ok"] and any("Technical Skills" in e for e in r["errors"]), r
    r = validate(GOOD.replace("**Tools** – Git", "Tools: Git"))
    assert not r["ok"] and any(e.startswith("line 10: skill line must look like **Label** – a, b, c") for e in r["errors"]), r
    r = validate(GOOD.replace("### **Engineer**, Acme || 2025\n", ""))
    assert not r["ok"] and any(e.startswith("line 5: bullet outside an entry") for e in r["errors"]), r
    r = validate("")
    assert not r["ok"] and r["errors"] == ["file is empty"]
    r = validate(GOOD.replace("|| 2025", ""))
    assert r["ok"] and any("no '|| date'" in w for w in r["warnings"]), r
    r = validate(GOOD.replace("## Technical Skills", "## technical skills"))
    assert r["ok"] and any("spelled" in w for w in r["warnings"]), r
    assert not validate("no heading\n## A\n")["ok"]
    with tempfile.TemporaryDirectory() as d:
        bad = pathlib.Path(d, "bad.md")
        bad.write_bytes(b"# Name\n\xff\xfe broken\n")
        r = validate_file(bad)
        assert not r["ok"] and "not UTF-8" in r["errors"][0], r
        assert not validate_file(pathlib.Path(d, "nope.md"))["ok"]
        # sync: newer wins, missing is created, equal is in sync
        md, txt = pathlib.Path(d, "r.md"), pathlib.Path(d, "r.txt")
        md.write_text("# A\n", encoding="utf-8")
        assert sync(md).startswith("md -> txt") and txt.read_text(encoding="utf-8") == "# A\n"
        assert sync(txt) == "in sync"
        txt.write_text("# B\n", encoding="utf-8")
        os.utime(txt, (md.stat().st_atime + 10, md.stat().st_mtime + 10))
        assert sync(pathlib.Path(d, "r")).startswith("txt -> md") and md.read_text(encoding="utf-8") == "# B\n"
        try:
            sync(pathlib.Path(d, "missing"))
            assert False
        except ValueError:
            pass
    # skills file
    sk, adj = parse_skills("## Skills\n- Python · main\n- C++\n- Git\n- SQL\n\n## Adjacent\n- Rust · near: C++ work\n")
    assert sk == {"Python": "main", "C++": "", "Git": "", "SQL": ""} and adj == {"Rust": "near: C++ work"}
    # adjacent entries count only with a declared kind (prompts/skill-rules.md): C is part of C++; Rust is not near
    ok, refused = allowed_skills("## Skills\n- C++\n\n## Adjacent\n- C · part of: C++ extension\n"
                                 "- Rust · near: C++ work\n- Go · describes:\n")
    assert ok == {"C++", "C"} and set(refused) == {"Rust", "Go"}, (ok, refused)
    errs = ats(GOOD, GOOD.replace("Python, C++", "Python, Rust, C++"), ok | {"Python", "Git"}, refused=refused)[0]
    assert len(errs) == 1 and "Adjacent entry must be" in errs[0], errs
    # a concept is refused even when another section lists it (any case); the error names the tool to list instead
    ok, refused = allowed_skills("## Skills\n- Matplotlib\n- data visualization\n\n## Adjacent\n"
                                 "- Version Control · same as: Git\n\n## Concepts\n- Data Visualization → Matplotlib\n"
                                 "- Version Control -> Git\n")
    assert ok == {"Matplotlib"} and "list Matplotlib instead" in refused["data visualization"], (ok, refused)
    errs = ats(GOOD, GOOD.replace("**Tools** – Git", "**Tools** – Git, Version Control"), ok | {"Python", "C++", "Git"},
               refused=refused)[0]
    assert errs == ["Version Control is a concept, not a tool: list Git instead"], errs
    # a technique is allowed, but only on its line (Deep Learning on ML/AI, never on Tools)
    tk = "## Skills\n- PyTorch\n\n## Techniques (only on: ML/AI)\n- Deep Learning · PyTorch nets\n"
    ok, refused = allowed_skills(tk)
    ml = GOOD.replace("**Tools** – Git", "**Tools** – Git\n**ML/AI** – PyTorch")
    assert "Deep Learning" in ok and ats(ml, ml.replace("– PyTorch", "– Deep Learning, PyTorch"), ok | {"Python", "C++", "Git"},
                                         refused=refused, placement=techniques(tk))[0] == []
    errs = ats(ml, ml.replace("– Git", "– Git, Deep Learning"), ok | {"Python", "C++", "Git"}, refused=refused,
               placement=techniques(tk))[0]
    assert errs == ["Deep Learning is a technique, not a tool: it goes on the ML/AI line, not Tools"], errs
    assert parse_skills(skills_from_template(GOOD))[0].keys() == {"Python", "C++", "Git"}
    allowed = set(sk) | set(adj)
    # ats
    assert ats(GOOD, GOOD, allowed) == ([], [], [], [])
    e, added, dropped, reo = ats(GOOD, GOOD.replace("Python, C++", "C++, SQL, Python").replace("– Git", "– Rust, Git"), allowed)
    assert e == [] and added == ["SQL", "Rust"] and dropped == [] and reo[0] == {"label": "Lang", "before": ["Python", "C++"],
           "after": ["C++", "SQL", "Python"]}, (e, added, reo)
    swapped = GOOD.replace("**Lang** – Python, C++\n**Tools** – Git", "**Tools** – Git\n**Lang** – Python, C++")
    assert ats(GOOD, swapped, allowed)[0] == [], "skill lines may be reordered"
    assert any("not in skills file" in x for x in ats(GOOD, GOOD.replace("Git", "Git, Zig"), allowed)[0])
    assert any("duplicate" in x for x in ats(GOOD, GOOD.replace("– Git", "– Git, Python"), allowed)[0])
    assert any("only Technical Skills" in x for x in ats(GOOD, GOOD.replace("20 networks", "25 networks"), allowed)[0])
    assert any("labels" in x for x in ats(GOOD, GOOD.replace("**Tools**", "**DevOps**"), allowed)[0])
    skills = GOOD[GOOD.index("## Technical"):]
    top = GOOD.replace(skills, "").replace("## Work", skills + "\n## Work")
    assert any("sections" in x for x in ats(GOOD, top, allowed)[0]), "skills stay where the template puts them"
    assert repeated_openers(GOOD) == []
    dup = GOOD.replace("- Trained 20 networks in PyTorch", "- Trained 20 networks in PyTorch\n- **Trained** a baseline")
    assert repeated_openers(dup) == ["Work Experience: 'trained' opens 2 bullets"], repeated_openers(dup)
    edu = "# A\n\n## Education\n### **School**, City || May 2029\n\n## Work Experience\n### **Job** || Jan 2025\n- Did a thing\n"
    assert redact(edu) == edu.replace(" || May 2029", ""), redact(edu)  # only Education dates go
    assert regrad(edu, "Dec 2028") == edu.replace("May 2029", "Dec 2028") and edu_date(edu) == "May 2029"
    assert use_early_grad(edu, "Dec 2028", "2028") and use_early_grad(edu, "Dec 2028", "December 2028")
    assert not use_early_grad(edu, "Dec 2028", "Spring 2028") and not use_early_grad(edu, "Dec 2028", "Jun 2028")
    assert not use_early_grad(edu, "Dec 2028", "2029") and not use_early_grad(edu, "Dec 2028", "")
    assert not use_early_grad(edu, "", "2028")
    assert ats(edu, regrad(edu, "Dec 2028"), set(), grad="Dec 2028")[0] == []
    assert ats(edu, regrad(edu, "Dec 2028"), set())[0], "an unannounced date change fails"
    print("selftest ok")


def main(a):
    if a[:1] == ["--test"]:
        selftest()
    elif a[:1] == ["validate"] and len(a) in (2, 3):
        if pathlib.Path(a[1]).with_suffix(".txt").is_file():
            sync(a[1])
        res = validate_file(a[1])
        if res["ok"] and a[2:] == ["--render"]:
            import tempfile
            sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
            from render import render
            with tempfile.TemporaryDirectory() as d:
                rr = render(a[1], pathlib.Path(d, "t.pdf"))
            if (rr["pages"] or 0) > 1:
                res["warnings"].append(f"your template is already over one page ({rr['pages']} pages)")
            elif not rr["ok"]:
                res["warnings"].append(f"test render failed: {rr['error']}")
        emit(res, res["ok"])
    elif a[:1] == ["ats"] and len(a) >= 5 and a[3] == "--skills" and a[5:] in (
            [], ["--redact"], ["--grad", *a[6:7]], ["--redact", "--grad", *a[7:8]]) and a[-1] != "--grad":
        try:
            sk = read(a[4])
            allowed, refused = allowed_skills(sk)
            grad = a[a.index("--grad") + 1] if "--grad" in a else None
            errs, added, dropped, reo = ats(read(a[1]), read(a[2]), allowed, "--redact" in a, refused,
                                            techniques(sk), grad)
        except (OSError, UnicodeDecodeError, ValueError) as ex:
            emit({"ok": False, "errors": [f"{type(ex).__name__}: {ex}"], "added": [], "dropped": [], "reorders": []}, False)
        emit({"ok": not errs, "errors": errs, "added": added, "dropped": dropped, "reorders": reo}, not errs)
    elif a[:1] == ["sync"] and len(a) == 2:
        try:
            emit({"ok": True, "status": sync(a[1])})
        except (ValueError, OSError) as ex:
            emit({"ok": False, "status": "", "error": str(ex)}, False)
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main(sys.argv[1:])
