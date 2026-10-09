"""Markdown-dialect resume -> LaTeX (latex/resume.tex) -> PDF via Tectonic.
A template with its own <name>.tex layout next to it is printed with that layout instead (see fill_layout).

  python render.py <resume.md> <out.pdf>   # prints {"ok", "pages", "letter", "text_ok", "error"} as the last stdout line
  python render.py --test

Checks (exit 1 on failure): exactly 1 page, MediaBox 612x792 pt (US Letter), and every source word appears in the
PDF text in order (text_ok is null when neither pdftotext nor pypdf is available).
Tectonic lookup: env CAREER_TAILOR_TECTONIC, then PATH, then the user data dir (see setup_tectonic.py).
"""
import json, os, pathlib, re, shutil, subprocess, sys, tempfile, unicodedata, zlib

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from resume import parse, plain, read, skill_lines, SKILL

TEMPLATE = HERE / "latex" / "resume.tex"
SPECIAL = {"&": r"\&", "%": r"\%", "$": r"\$", "#": r"\#", "_": r"\_", "{": r"\{", "}": r"\}",
           "~": r"\textasciitilde{}", "^": r"\textasciicircum{}", "\\": r"\textbackslash{}"}


def data_dir():
    """Per-user dir where setup_tectonic.py installs Tectonic."""
    if os.name == "nt":
        return pathlib.Path(os.environ.get("APPDATA") or pathlib.Path.home() / "AppData/Roaming") / "career-tailor" / "tectonic"
    return pathlib.Path.home() / ".local/share/career-tailor/tectonic"


def exe_name():
    return "tectonic.exe" if os.name == "nt" else "tectonic"


def find_tectonic():
    """-> path string or None. Order: env CAREER_TAILOR_TECTONIC, PATH, user data dir."""
    env = os.environ.get("CAREER_TAILOR_TECTONIC")
    if env and pathlib.Path(env).is_file():
        return env
    on_path = shutil.which("tectonic")
    if on_path:
        return on_path
    local = data_dir() / exe_name()
    return str(local) if local.is_file() else None


def tex(s):
    """Escape LaTeX specials, then turn **bold** / *italic* into \\textbf / \\textit."""
    s = re.sub(r"[&%$#_{}~^\\]", lambda m: SPECIAL[m.group()], s)
    s = re.sub(r"\*\*(.+?)\*\*", r"\\textbf{\1}", s)
    return re.sub(r"\*(.+?)\*", r"\\textit{\1}", s)


def to_latex(md):
    d = parse(md)
    body = []
    for sec, blocks in d["sections"]:
        body.append(f"\\resumeSection{{{tex(sec.upper())}}}")
        prev = None
        for blk in blocks:
            if blk[0] == "para":
                gap = SKILL.match(blk[1]) and prev is not None and not (prev[0] == "para" and SKILL.match(prev[1]))
                body.append(("\\resumeGap\n" if gap else "") + tex(blk[1]) + r"\par")
            else:
                left, _, date = blk[1].partition("||")
                body.append(("\\resumeGap\n" if prev else "") + f"\\resumeEntry{{{tex(left.strip())}}}{{{tex(date.strip())}}}")
                if blk[2]:
                    body.append("\\begin{itemize}\n" + "\n".join(f"  \\item {tex(b)}" for b in blk[2]) + "\n\\end{itemize}")
            prev = blk
        body.append("")
    contact = "\n".join(tex(l) + r"\\" for l in d["head"][1:]).removesuffix(r"\\")
    t = TEMPLATE.read_text(encoding="utf-8")
    # plain str.replace (not re.sub) so backslashes in the filled text are kept literally
    return (t.replace("%%NAME%%", tex(d["head"][0].lstrip("# ")))
             .replace("%%CONTACT%%", contact)
             .replace("%%BODY%%", "\n".join(body)))


def layout_of(md_path):
    """A template's own layout: <name>.tex next to <name>.md (the tailor copies it next to resume.md), or None."""
    p = pathlib.Path(md_path).with_suffix(".tex")
    return p if p.is_file() else None


def fill_layout(md, layout):
    """A hand-made layout reproduces the original resume exactly; only its `%%SKILLS%%` line is generated, as one
    \\skillline{Label}{items} per Technical Skills line. Education dates removed from the markdown (redact) also
    blank the layout's \\edudate{...}."""
    t = layout.read_text(encoding="utf-8")
    lines = [l for l in t.split("\n") if l.strip() == "%%SKILLS%%"]
    if len(lines) != 1:
        raise ValueError(f"{layout.name} needs exactly one line that is just %%SKILLS%%")
    d = parse(md)
    skills = "\n".join(f"\\skillline{{{tex(label)}}}{{{tex(', '.join(items))}}}" for label, items in skill_lines(d).items())
    t = t.replace(lines[0], skills)
    edu = next((b for s, b in d["sections"] if s.lower() == "education"), [])
    if any(b[0] == "entry" and "||" not in b[1] for b in edu):
        t = t.replace("\\begin{document}", "\\renewcommand{\\edudate}[1]{}\n\\begin{document}", 1)
    return t


# ---------- verification ----------

def source_words(md):
    """Words the PDF must contain, in order: markup stripped, section names uppercased like the template."""
    d = parse(md)
    lines = [d["head"][0].lstrip("# ")] + d["head"][1:]
    for sec, blocks in d["sections"]:
        lines.append(sec.upper())
        for b in blocks:
            lines += [b[1]] + (b[2] if b[0] == "entry" else [])
    return plain(" ".join(lines).replace("||", " ")).split()


def squash(s):
    """Comparison form: NFKC (ligatures), lowercase, letters/digits only, so whitespace, hyphen breaks,
    quotes, dashes and the bullet glyph cannot cause false mismatches."""
    return re.sub(r"[\W_]+", "", unicodedata.normalize("NFKC", s).lower())


def text_diff(md, pdf_text):
    """-> None if every source word appears in order, else 'text mismatch near: ...'."""
    words = source_words(md)
    a, b = squash("".join(words)), squash(pdf_text)
    if a == b:
        return None
    i = next((k for k, (x, y) in enumerate(zip(a, b)) if x != y), min(len(a), len(b)))
    pos, w = 0, 0
    for w, word in enumerate(words):
        pos += len(squash(word))
        if pos > i:
            break
    return "text mismatch near: " + " ".join(words[max(0, w - 4):w + 5])


def pdf_text(pdf):
    exe = shutil.which("pdftotext")
    if exe:
        r = subprocess.run([exe, "-raw", "-enc", "UTF-8", str(pdf), "-"], capture_output=True, encoding="utf-8", errors="replace")
        return r.stdout
    try:
        from pypdf import PdfReader
        return "\n".join(p.extract_text() for p in PdfReader(str(pdf)).pages)
    except ImportError:
        return None


def media_boxes(pdf):
    raw = pathlib.Path(pdf).read_bytes()
    for s in re.findall(rb"stream\r?\n(.*?)endstream", raw, re.S):  # page dicts may sit in compressed object streams
        try:
            raw += zlib.decompress(s)
        except zlib.error:
            pass
    boxes = [tuple(round(float(x)) for x in m) for m in
             re.findall(rb"/MediaBox\s*\[\s*([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s*\]", raw)]
    if not boxes:
        try:
            from pypdf import PdfReader
            boxes = [tuple(round(float(v)) for v in p.mediabox) for p in PdfReader(str(pdf)).pages]
        except ImportError:
            pass
    return boxes


def render(md_path, pdf_path):
    """Compile in a temp dir, verify. -> {"ok", "pages", "letter", "text_ok", "error"}; never raises."""
    res = {"ok": False, "pages": None, "letter": None, "text_ok": None, "error": ""}
    try:
        exe = find_tectonic()
        if not exe:
            res["error"] = ("Tectonic not found. Run `python setup_tectonic.py`, put tectonic on PATH, "
                            "or set CAREER_TAILOR_TECTONIC to its full path.")
            return res
        md_text = read(md_path)
        pdf = pathlib.Path(pdf_path).resolve()
        with tempfile.TemporaryDirectory() as tmp:  # compile aside so an open PDF viewer can't break the build
            src = pathlib.Path(tmp, pdf.with_suffix(".tex").name)
            layout = layout_of(md_path)
            src.write_text(fill_layout(md_text, layout) if layout else to_latex(md_text), encoding="utf-8")
            r = subprocess.run([exe, "--keep-logs", "--outdir", tmp, str(src)],
                               capture_output=True, text=True, encoding="utf-8", errors="replace")
            if r.returncode:
                res["error"] = f"tectonic failed:\n{r.stdout[-1500:]}\n{r.stderr[-1500:]}"
                return res
            log = src.with_suffix(".log").read_text(encoding="utf-8", errors="replace")
            m = re.search(r"Output written on .*?\((\d+) pages?", log)
            pdf.parent.mkdir(parents=True, exist_ok=True)
            try:
                shutil.copyfile(pathlib.Path(tmp) / pdf.name, pdf)
            except PermissionError:
                res["error"] = f"{pdf.name} is open in another program (PDF viewer?). Close it and rerun."
                return res
        res["pages"] = int(m.group(1)) if m else None
        boxes = media_boxes(pdf)
        res["letter"] = boxes == [(0, 0, 612, 792)]
        text = pdf_text(pdf)
        if text is not None:
            bad = text_diff(md_text, text)
            res["text_ok"] = bad is None
        if res["pages"] != 1:
            res["error"] = f"pages: {res['pages']} (must be exactly 1); shorten the skills lines or bullets"
        elif not res["letter"]:
            res["error"] = f"page size {boxes or 'unreadable'} is not US Letter [(0, 0, 612, 792)] pt"
        elif text is not None and bad:
            res["error"] = bad
        res["ok"] = not res["error"]
    except Exception as ex:
        res["error"] = f"{type(ex).__name__}: {ex}"
    return res


SAMPLE = "# Alex Rivera\nalex@example.com | Springfield\n\n## Skills\n### **Engineer**, Acme || 2025\n- Shipped a *fine* flow – 50% & more\n\n## Technical Skills\n**Lang** – Python, C++\n"


def selftest():
    assert tex("C++ & ~9,500 50% $x #1 a_b {c}") == r"C++ \& \textasciitilde{}9,500 50\% \$x \#1 a\_b \{c\}"
    assert tex(r"**R&D** *it* a\b") == r"\textbf{R\&D} \textit{it} a\textbackslash{}b"
    out = to_latex(SAMPLE)
    assert "%%" not in out and r"\resumeSection{SKILLS}" in out and r"\resumeEntry{\textbf{Engineer}, Acme}{2025}" in out
    # text match: markup, uppercase headers, ligatures, hyphen break, bullet glyph, dashes all normalise
    src = "# Alex Rivera\na@b.c\n\n## Skills\n### **Lead**, Co || 2025\n- Shipped a *fine* flow – 50%\n"
    pdf = "Alex Rivera\na@b.c\nSKILLS\nLead, Co 2025\n● Shipped a ﬁne ﬂow \u2013\n50%\n"
    assert text_diff(src, pdf) is None
    assert "fine" in text_diff(src, pdf.replace("ﬁne", "fin")) and "flow" in text_diff(src, pdf.replace("ﬂow", "ﬂaw"))
    assert text_diff(src, pdf.replace("Lead, Co 2025", "Co Lead 2025")) is not None
    old = os.environ.get("CAREER_TAILOR_TECTONIC")
    os.environ["CAREER_TAILOR_TECTONIC"] = __file__
    assert find_tectonic() == __file__
    if old is None:
        del os.environ["CAREER_TAILOR_TECTONIC"]
    else:
        os.environ["CAREER_TAILOR_TECTONIC"] = old
    if find_tectonic():  # real compile only when Tectonic is installed
        with tempfile.TemporaryDirectory() as d:
            md = pathlib.Path(d, "r.md")
            md.write_text(SAMPLE, encoding="utf-8")
            r = render(md, pathlib.Path(d, "r.pdf"))
            assert r["ok"] and r["pages"] == 1 and r["letter"], r
    else:
        print("note: tectonic not found, compile test skipped")
    print("selftest ok")


if __name__ == "__main__":
    a = sys.argv[1:]
    if a == ["--test"]:
        selftest()
    elif len(a) == 2:
        res = render(*a)
        print(json.dumps(res, ensure_ascii=False))
        sys.exit(0 if res["ok"] else 1)
    else:
        sys.exit(__doc__)
