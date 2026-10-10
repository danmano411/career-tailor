"""Keep the run history short: delete old auto-scan runs, keep every applied resume.

  python prune.py --work-dir <runs> --out-dir <output> --keep-days 7 [--dry-run]
  python prune.py --test

Applied runs (run.json has "applied") are never deleted; their PDF moves to <output>/Applied Resumes and run.json
"output" points there. Auto-scan runs (id "scan...") started more than keep-days ago are deleted: the run folder,
its PDF in the output folder, then empty date folders and old <runs>/_scans work folders. Runs you started by hand
are never deleted. keep-days 0 deletes nothing. Prints one JSON line.
"""
import argparse, datetime, json, pathlib, re, shutil, sys

APPLIED = "Applied Resumes"
DAY = re.compile(r"\d{4}-\d{2}-\d{2}")


def file_applied(run_json, out_dir):
    """Move an applied run's PDF into <out_dir>/Applied Resumes and point run.json at it. Returns the new path, or ''
    when there's no PDF to file. A PDF open in a viewer can't be moved on Windows: it's copied, and the old one stays."""
    path = pathlib.Path(run_json)
    rec = json.loads(path.read_text(encoding="utf-8"))
    dest_dir = pathlib.Path(out_dir).resolve() / APPLIED
    src = pathlib.Path(rec.get("output") or "").resolve()
    if rec.get("output") and src.parent == dest_dir and src.is_file():
        return str(src)
    keep_src = not (rec.get("output") and src.is_file())
    if keep_src:  # the output PDF is gone: file the run folder's copy instead
        src = pathlib.Path(rec.get("pdf") or "")
        if not (rec.get("pdf") and src.is_file()):
            return ""
    dest = dest_dir / (pathlib.Path(rec.get("output") or "").name or f"{path.parent.name}.pdf")
    if dest.exists():
        dest = dest.with_name(f"{dest.stem} ({path.parent.name}).pdf")
    dest_dir.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dest)
    if not keep_src:
        try:
            src.unlink()
        except OSError:
            pass
    rec["output"] = str(dest)
    path.write_text(json.dumps(rec, indent=1), encoding="utf-8")
    return str(dest)


def prune(work_dir, out_dir, keep_days, today=None, dry=False, prefixes=("scan",)):
    cutoff = ((today or datetime.date.today()) - datetime.timedelta(days=keep_days)).isoformat()
    out = pathlib.Path(out_dir).resolve()
    filed, gone, errors = [], [], []
    for f in sorted(pathlib.Path(work_dir).glob("*/run.json")):
        try:
            rec = json.loads(f.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if rec.get("applied"):
            if not (rec.get("output") and pathlib.Path(rec["output"]).resolve().parent == out / APPLIED):
                filed.append(f.parent.name if dry else file_applied(f, out))
            continue
        if (keep_days <= 0 or not str(rec.get("id", "")).startswith(tuple(prefixes))
                or rec.get("status") in ("queued", "running")):
            continue
        if (rec.get("started") or f.parent.name)[:10] >= cutoff:
            continue
        gone.append(f.parent.name)
        if dry:
            continue
        pdf = pathlib.Path(rec.get("output") or "").resolve()
        try:
            if rec.get("output") and out in pdf.parents and out / APPLIED not in pdf.parents:
                pdf.unlink(missing_ok=True)
            shutil.rmtree(f.parent)
        except OSError as ex:  # a file open elsewhere; the next prune tries again
            errors.append(f"{f.parent.name}: {ex}")
    if keep_days > 0 and not dry:
        scans = pathlib.Path(work_dir) / "_scans"
        for d in (scans.iterdir() if scans.is_dir() else []):
            if d.is_dir() and DAY.match(d.name) and d.name[:10] < cutoff:
                shutil.rmtree(d, ignore_errors=True)
        for d in (out.iterdir() if out.is_dir() else []):
            if d.is_dir() and DAY.fullmatch(d.name) and d.name < cutoff and not any(d.iterdir()):
                d.rmdir()
    return {"cutoff": cutoff, "pruned": len(gone), "filed": len([x for x in filed if x]), "runs": gone,
            "errors": errors}


def selftest():
    import tempfile
    with tempfile.TemporaryDirectory() as t:
        t = pathlib.Path(t)
        work, out = t / "jobs", t / "out"

        def run(name, rid, started, applied=False, out_day="2026-10-01"):
            d = work / name
            d.mkdir(parents=True)
            (d / "resume.pdf").write_bytes(b"%PDF")
            pdf = out / out_day / f"{name}.pdf"
            pdf.parent.mkdir(parents=True, exist_ok=True)
            pdf.write_bytes(b"%PDF")
            rec = {"id": rid, "status": "done", "started": started, "pdf": str(d / "resume.pdf"), "output": str(pdf)}
            if applied:
                rec["applied"] = {"date": started[:10], "ok": True, "link": "", "error": ""}
            (d / "run.json").write_text(json.dumps(rec), encoding="utf-8")
            return d, pdf
        old, old_pdf = run("old", "scan10011146-001", "2026-10-01T12:00:00")
        sent, sent_pdf = run("sent", "scan10011146-002", "2026-10-01T12:00:00", applied=True)
        mine, _ = run("mine", "a1b2c3d4", "2026-10-01T09:00:00", out_day="2026-10-02")
        new, new_pdf = run("new", "scan10091146-001", "2026-10-09T12:00:00", out_day="2026-10-09")
        (work / "_scans" / "2026-10-01-1146").mkdir(parents=True)
        (work / "_scans" / "2026-10-09-1146").mkdir(parents=True)
        today = datetime.date(2026, 10, 10)

        assert prune(work, out, 7, today, dry=True)["runs"] == ["old"] and old.exists() and sent_pdf.exists()
        r = prune(work, out, 7, today)
        assert r["runs"] == ["old"] and r["filed"] == 1 and r["cutoff"] == "2026-10-03", r
        assert not old.exists() and not old_pdf.exists() and mine.exists() and new.exists() and new_pdf.exists()
        assert sent.exists() and not sent_pdf.exists()  # applied: kept, PDF moved
        moved = pathlib.Path(json.loads((sent / "run.json").read_text(encoding="utf-8"))["output"])
        assert moved == out / APPLIED / "sent.pdf" and moved.is_file()
        assert not (out / "2026-10-01").exists() and (out / "2026-10-02").exists()  # emptied date folder removed
        assert not (work / "_scans" / "2026-10-01-1146").exists() and (work / "_scans" / "2026-10-09-1146").exists()
        assert prune(work, out, 7, today) == {"cutoff": "2026-10-03", "pruned": 0, "filed": 0, "runs": [], "errors": []}
        assert prune(work, out, 0, datetime.date(2027, 1, 1))["pruned"] == 0 and new.exists()  # 0 = keep everything

        # output PDF deleted by hand: the run folder's copy is filed
        gone, gone_pdf = run("gone", "scan10091146-002", "2026-10-09T12:00:00", applied=True, out_day="2026-10-09")
        gone_pdf.unlink()
        assert file_applied(gone / "run.json", out) == str(out / APPLIED / "gone.pdf") and (gone / "resume.pdf").exists()
    print("prune selftest ok")


def main(argv):
    if argv == ["--test"]:
        selftest()
        return 0
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--work-dir", required=True)
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--keep-days", type=int, default=0)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--prefixes", default="scan", help="comma-separated run id prefixes that count as auto-scanned")
    a = ap.parse_args(argv)
    res = prune(a.work_dir, a.out_dir, a.keep_days, dry=a.dry_run, prefixes=a.prefixes.split(","))
    print(json.dumps(res, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
