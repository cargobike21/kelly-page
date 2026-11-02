"""Checks for kelly_qr.py (the bridge's QR encoder, for --connect-qr) -- every version 1-10 is decoded back by the
vendored jsQR (kelly-page/vendor/jsqr-1.4.0) in headless Chrome / Edge.
Run: python3 bridge/test_kelly_qr.py  (stdlib only; prints RESULT: ALL PASS / FAIL; the decode part skips without a browser)

Covers: the symbol size per version, the finder patterns, a too-long text refused, the terminal rendering, and a real
decode of URL-shaped texts from 1 to 213 bytes (each version's limit at level M)."""
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import kelly_qr  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
fails = []


def check(name, ok, got=None):
    print(("PASS " if ok else "FAIL ") + name + ("" if ok else f"  (got {got!r})"))
    if not ok:
        fails.append(name)


# byte capacity at level M per version (ISO 18004 table 7)
CAP = {1: 14, 2: 26, 3: 42, 4: 62, 5: 84, 6: 106, 7: 122, 8: 152, 9: 180, 10: 213}
for v, n in CAP.items():
    check(f"version {v}: {n} bytes fit, {v * 4 + 17} modules", len(kelly_qr.matrix("x" * n)) == v * 4 + 17, len(kelly_qr.matrix("x" * n)))
    if v < 10:
        check(f"version {v}: {n + 1} bytes go to version {v + 1}", len(kelly_qr.matrix("x" * (n + 1))) == (v + 1) * 4 + 17)
try:
    kelly_qr.matrix("x" * 214)
    check("214 bytes refused", False, "no error")
except ValueError:
    check("214 bytes refused", True)
m = kelly_qr.matrix("https://10.0.30.50:8443/?token=abcdefghjk")
finder = [[max(abs(x - 3), abs(y - 3)) not in (2, 4) for x in range(7)] for y in range(7)]
check("finder pattern top-left", [r[:7] for r in m[:7]] == finder)
check("finder pattern top-right", [r[-7:] for r in m[:7]] == finder)
check("finder pattern bottom-left", [r[:7] for r in m[-7:]] == finder)
check("dark module", m[len(m) - 8][8] is True)
t = kelly_qr.terminal("hello").splitlines()
check("terminal: half-block rows", len(t) == (21 + 4 + 1) // 2 and all(len(r) == 25 for r in t), [len(r) for r in t])
check("terminal: quiet zone is light", set(t[0]) == {"█"})

# real decode: jsQR over each code drawn as an image. Chrome before Edge: Edge's --dump-dom prints nothing into a pipe
browser = next((p for p in (os.environ.get("CHROME", ""), r"C:\Program Files\Google\Chrome\Application\chrome.exe",
                            r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe", "/usr/bin/chromium", "/usr/bin/chromium-browser")
                if p and Path(p).exists()), None) or shutil.which("chromium")
if not browser:
    print("SKIP jsQR decode: no Chrome / Edge / Chromium here")
else:
    texts = ["https://10.0.30.50:8443/?token=rvcnhabcdefghjkmnpqrstuvwxyz2345"] + \
            [("https://kelly.local:8443/?token=" + "abcdefghjk" * 22)[:n] for n in (1, 14, 26, 42, 62, 84, 106, 122, 152, 180, 213)] + \
            ["héllo wörld ✓ ünïcode"]
    codes = [kelly_qr.matrix(s) for s in texts]
    jsqr = (ROOT / "vendor" / "jsqr-1.4.0" / "jsQR.js").as_uri()
    page = f"""<!doctype html><meta charset="utf-8"><script src="{jsqr}"></script><pre id="out"></pre><script>
const codes = {json.dumps([[[1 if v else 0 for v in r] for r in c] for c in codes])}, S = 6, Q = 4, out = [];
for (const c of codes) {{
  const n = (c.length + 2 * Q) * S, img = new Uint8ClampedArray(n * n * 4).fill(255);
  c.forEach((row, y) => row.forEach((v, x) => {{ if (!v) return;
    for (let dy = 0; dy < S; dy++) for (let dx = 0; dx < S; dx++) {{ const i = (((y + Q) * S + dy) * n + (x + Q) * S + dx) * 4; img[i] = img[i + 1] = img[i + 2] = 0; }} }}));
  const r = jsQR(img, n, n); out.push(r ? r.data : null);
}}
document.getElementById('out').textContent = 'JSON:' + JSON.stringify(out);
</script>"""
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as d:   # the browser may still hold its profile
        f = Path(d) / "qr.html"
        f.write_text(page, encoding="utf-8")
        # its own profile: without one, a headless launch hands off to an Edge / Chrome already open and dumps nothing
        r = subprocess.run([browser, "--headless=new", "--disable-gpu", "--allow-file-access-from-files", f"--user-data-dir={Path(d) / 'profile'}",
                            "--no-first-run", "--dump-dom", f.as_uri()],
                           capture_output=True, text=True, encoding="utf-8", timeout=120)
    got = None
    for line in r.stdout.splitlines():
        if '<pre id="out">JSON:' in line:
            import html
            got = json.loads(html.unescape(line.split('<pre id="out">JSON:', 1)[1].split("</pre>")[0]))
    if got is None:
        check("jsQR ran", False, r.stdout[-300:] + r.stderr[-300:])
    else:
        for s, g in zip(texts, got):
            check(f"jsQR decodes {len(s.encode())} bytes (version {(len(kelly_qr.matrix(s)) - 17) // 4})", g == s, g)

print("RESULT: " + ("FAIL " + ", ".join(fails) if fails else "ALL PASS"))
sys.exit(1 if fails else 0)
