#!/usr/bin/env python3
"""Kelly keeper -- keep Kelly Page on the radio while nobody else is using it (Raspberry Pi install).

  python3 kelly_keeper.py [--port 8025] [--profile DIR] [--config FILE]

Kelly's logic runs in a browser, so with the PC asleep nothing answered the radio: the bridge stayed up
but the gateway lost the station (2026-10-12, 21:49 -> 05:06). This runs Kelly in headless Chromium on
http://localhost:<port>/?connect=ip&token=... instead, and steps aside for a person:

  - someone opens Kelly from another computer -> the bridge (run with --keeper-local) drops this one off the
    radio at once and refuses it while they're connected. The browser here KEEPS RUNNING, so its LoRa Mesh page
    and APRS iGate go on: while their Kelly uses the LoRa node too, the bridge has this one only listen (it hears
    every frame, sends nothing) and its iGate is the station's, theirs stands by (2026-11-01: a PC tab held the
    radio for 7 h and gated almost nothing)
  - 10 s after the last of them leaves -> Kelly is reloaded here, reconnects and parks the radio as usual
  - not connected 90 s after starting (radio not answering, page stuck) -> restarted

--config: a Kelly configuration file (Admin > Save config) for the headless copy, which has its own browser
storage. Applied whenever the file changes, with overrides for running unattended: IP connection, no sound
or effects, no automatic update downloads (update the Pi with install-pi.sh instead).

The page is opened with &keeper, so it posts its log (calls, texts, statuses, alerts...) to the bridge as it
goes and once more as it's dropped; a PC Kelly connecting picks that up and merges it (js/app.js "Pi keeper
hand-over"), so it needn't ask the gateway over the air for what the Pi already heard.
Token: KELLY_BRIDGE_TOKEN in the environment (/etc/kelly-bridge.env). Stdlib only.
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import shutil
import signal
import socket
import struct
import subprocess
import time
import urllib.parse
import urllib.request

DEBUG_PORT = 9229              # Chromium's DevTools, on 127.0.0.1 only (Chromium's default bind)
REST_AFTER_USER_S = 10         # wait this long after the last person leaves before taking the radio back
ATTACH_TIMEOUT_S = 90          # started but not connected to the bridge by then -> restart
UNATTENDED = {"connType": "ip", "sound": False, "fx": False, "splash": False, "kuAuto": False}


def log(msg: str) -> None:
    print(f"[keeper] {msg}", flush=True)


def get_json(url: str, timeout: float = 3) -> dict | list | None:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            return json.loads(r.read())
    except (OSError, ValueError):
        return None


class Cdp:
    """A minimal DevTools client: one page, Runtime.evaluate / Page.navigate (stdlib WebSocket)."""

    def __init__(self, ws_url: str):
        u = urllib.parse.urlparse(ws_url)
        self.sock = socket.create_connection((u.hostname, u.port), timeout=20)
        key = base64.b64encode(os.urandom(16)).decode()
        self.sock.sendall((f"GET {u.path} HTTP/1.1\r\nHost: {u.hostname}:{u.port}\r\nUpgrade: websocket\r\n"
                           f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
        head = b""
        while b"\r\n\r\n" not in head:
            chunk = self.sock.recv(1024)
            if not chunk:
                raise ConnectionError("DevTools closed the handshake")
            head += chunk
        if b" 101 " not in head.split(b"\r\n", 1)[0]:
            raise ConnectionError(head.split(b"\r\n", 1)[0].decode("latin-1"))
        self.buf, self.n = head.split(b"\r\n\r\n", 1)[1], 0

    def _send(self, text: str) -> None:
        data, mask = text.encode(), os.urandom(4)
        n = len(data)
        hdr = bytes([0x81]) + (bytes([0x80 | n]) if n < 126 else bytes([0x80 | 126]) + struct.pack(">H", n) if n < 65536
                               else bytes([0x80 | 127]) + struct.pack(">Q", n))
        self.sock.sendall(hdr + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))

    def _read(self, n: int) -> bytes:
        while len(self.buf) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise ConnectionError("DevTools closed")
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def _recv(self) -> str:
        msg = b""
        while True:
            b0, b1 = self._read(2)
            n = b1 & 0x7F
            n = struct.unpack(">H", self._read(2))[0] if n == 126 else struct.unpack(">Q", self._read(8))[0] if n == 127 else n
            msg += self._read(n)
            if b0 & 0x80:
                return msg.decode("utf-8", "replace")

    def call(self, method: str, **params):
        self.n += 1
        self._send(json.dumps({"id": self.n, "method": method, "params": params}))
        while True:
            m = json.loads(self._recv())
            if m.get("id") == self.n:
                return m.get("result", {})

    def eval(self, expr: str):
        r = self.call("Runtime.evaluate", expression=expr, awaitPromise=True, returnByValue=True)
        if "exceptionDetails" in r:
            raise RuntimeError(r["exceptionDetails"].get("exception", {}).get("description") or r["exceptionDetails"].get("text"))
        return r.get("result", {}).get("value")

    def close(self) -> None:
        try:
            self.sock.close()
        except OSError:
            pass


class Keeper:
    def __init__(self, a):
        self.a = a
        self.base = f"http://localhost:{a.port}"
        tok = os.environ.get("KELLY_BRIDGE_TOKEN", "")
        self.url = f"{self.base}/?connect=ip&keeper&nofx&nosplash" + (f"&token={urllib.parse.quote(tok)}" if tok else "")
        self.proc: subprocess.Popen | None = None
        self.started = 0.0
        self.last_user = 0.0
        self.yielded = False         # a person has the radio: this Kelly runs on without it (LoRa Mesh, iGate)
        self.applied = None          # config file mtime last applied

    def chromium(self) -> str:
        for name in ("chromium-headless-shell", "chromium", "chromium-browser", "google-chrome"):
            path = shutil.which(name) or (f"/usr/lib/chromium/{name}" if os.path.exists(f"/usr/lib/chromium/{name}") else None)
            if path:
                return path
        raise SystemExit("no Chromium found -- sudo apt install chromium-headless-shell")

    def start(self) -> None:
        cmd = [self.chromium(), "--headless", "--no-first-run", "--no-default-browser-check", "--disable-gpu",
               "--mute-audio", f"--user-data-dir={self.a.profile}", f"--remote-debugging-port={DEBUG_PORT}",
               # Kelly's timers (polls, HELLO, gateway retries) must keep running in an unseen page
               "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
               "--disable-backgrounding-occluded-windows", "--disable-features=CalculateNativeWinOcclusion",
               self.url]
        self.proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        self.started = time.monotonic()
        log(f"Kelly started in headless Chromium (pid {self.proc.pid})")

    def stop(self, why: str = "") -> None:
        if not self.proc:
            return
        if why:
            log(why)
        try:
            os.killpg(self.proc.pid, signal.SIGTERM)
            self.proc.wait(10)
        except (ProcessLookupError, subprocess.TimeoutExpired):
            try:
                os.killpg(self.proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        self.proc = None

    def retake(self) -> None:
        """The person has gone: reload Kelly so it connects to the radio again (a restart if the page won't answer)."""
        cdp = self.page() if self.proc else None
        try:
            if not cdp:
                raise ConnectionError("no page")
            cdp.call("Page.navigate", url=self.url)
            self.started = time.monotonic()
            log("the radio is free again -- Kelly reloaded to take it back")
        except (OSError, ConnectionError, ValueError):
            self.stop("the radio is free again -- restarting Kelly to take it back")
            self.start()
        finally:
            if cdp:
                cdp.close()

    def page(self) -> Cdp | None:
        tabs = get_json(f"http://127.0.0.1:{DEBUG_PORT}/json") or []
        tab = next((t for t in tabs if t.get("type") == "page" and t.get("url", "").startswith(self.base)), None)
        return Cdp(tab["webSocketDebuggerUrl"]) if tab else None

    def apply_config(self) -> None:
        """Load --config into the headless Kelly's storage: parse with Kelly's own configFromXml, write the
        storage from a plain page of the same site (a running Kelly would save over it as it unloads), reload."""
        path = self.a.config
        if not path or not os.path.exists(path):
            return
        mtime = os.path.getmtime(path)
        if mtime == self.applied:
            return
        cdp = self.page()
        if not cdp:
            return
        try:
            xml = open(path, encoding="utf-8").read()
            c = cdp.eval(f"kelly.configFromXml({json.dumps(xml)})")
            cdp.call("Page.navigate", url=f"{self.base}/vendor/leaflet-1.9.4/LICENSE")
            time.sleep(2)
            cdp.eval("""((c, over) => {
              const get = (k, d) => { try { return JSON.parse(localStorage.getItem('kelly.' + k)) ?? d; } catch { return d; } };
              const put = (k, v) => localStorage.setItem('kelly.' + k, JSON.stringify(v));
              const deep = (d, s) => { for (const [k, v] of Object.entries(s)) { if (v && typeof v === 'object' && !Array.isArray(v)) { d[k] = d[k] && typeof d[k] === 'object' ? d[k] : {}; deep(d[k], v); } else d[k] = v; } return d; };
              put('settings', Object.assign(deep(get('settings', {}), c.settings), over));
              if (c.statusLabels) put('statusLabels', c.statusLabels);
              if (c.presetLabels) put('presetLabels', c.presetLabels);
              for (const k of ['directory', 'tgs', 'aliases']) put(k, Object.assign(get(k, {}), c[k]));
            })(%s, %s)""" % (json.dumps(c), json.dumps(UNATTENDED)))
            cdp.call("Page.navigate", url=self.url)
            self.applied = mtime
            self.started = time.monotonic()      # it reconnects from scratch
            log(f"applied {os.path.basename(path)} (callsign {c.get('settings', {}).get('myCall') or '?'}, "
                f"home {c.get('settings', {}).get('home') or '?'}) and reloaded Kelly")
        except (OSError, RuntimeError, ConnectionError, ValueError) as e:
            log(f"couldn't apply {path}: {e}")
        finally:
            cdp.close()

    def run(self) -> None:
        signal.signal(signal.SIGTERM, lambda *_: (self.stop("stopping"), os._exit(0)))
        log(f"watching the bridge on port {self.a.port}")
        while True:
            time.sleep(2)
            now = time.monotonic()
            st = get_json(f"http://127.0.0.1:{self.a.port}/api/clients")
            if self.proc and self.proc.poll() is not None:
                log(f"Chromium exited (code {self.proc.returncode})")
                self.proc = None
            if not st or not st.get("radio"):
                self.stop("bridge or radio not up -- waiting")
                continue
            if st.get("clients"):
                self.last_user = now
                if not self.yielded:
                    self.yielded = True
                    log("someone opened Kelly from another computer -- radio handed over; LoRa Mesh and the iGate run on")
                if not self.proc:
                    self.start()     # (the bridge refuses it the radio meanwhile; its LoRa Mesh connects)
                continue
            if now - self.last_user < REST_AFTER_USER_S:
                continue
            if self.yielded:
                self.yielded = False
                self.retake()
                continue
            if not self.proc:
                self.start()
                continue
            if not st.get("keeper"):
                if now - self.started > ATTACH_TIMEOUT_S:
                    self.stop(f"not connected after {ATTACH_TIMEOUT_S} s -- restarting")
                continue
            if now - self.started > 8:
                self.apply_config()


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=8025)
    ap.add_argument("--profile", default=os.path.expanduser("~/.kelly-keeper"), help="Chromium profile (Kelly's storage)")
    ap.add_argument("--config", help="Kelly configuration file (.xml) to apply")
    Keeper(ap.parse_args()).run()


if __name__ == "__main__":
    main()
