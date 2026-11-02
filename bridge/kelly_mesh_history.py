"""LoRa Mesh history for the Kelly bridge (--mesh-history FILE, with --mesh-gateway): a small SQLite time series of
what the MeshCore node hears, so a Pi or PC install has trends without the P25X gateway's InfluxDB (Phase 4, 2026-10-21).

Samples go in with add(src, metric, value) -- src is "self" (this bridge's node) or a station's 6-byte key prefix (hex).
Each minute's samples are kept as one row (avg, min, max, n) and rolled up into 15-minute and 1-hour rows, recomputed
every minute so the open bucket is always current:

    res 60    1 minute    kept 48 h
    res 900   15 minutes  kept 35 days
    res 3600  1 hour      kept 400 days

and the file never holds more than MAX_ROWS rows (the oldest 1-minute rows go first). One commit a minute, WAL, so an
SD card isn't worn. A 0/1 metric (dm_ok, node_up) reads back as a ratio: avg = share of the time / of the attempts.
Stdlib only.
"""
from __future__ import annotations

import sqlite3
import time
from pathlib import Path

RES = ((60, 2 * 86400), (900, 35 * 86400), (3600, 400 * 86400))   # (bucket seconds, kept for)
MAX_ROWS = 400_000
MAX_POINTS = 1500       # a query picks the finest resolution that answers in at most this many points per metric
MAX_SOURCES = 300


class MeshHistory:
    def __init__(self, path: str | Path):
        self.path = Path(path).expanduser()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(str(self.path))
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=NORMAL")
        self.db.execute("CREATE TABLE IF NOT EXISTS series (res INTEGER, t INTEGER, src TEXT, m TEXT, avg REAL, mn REAL, mx REAL, n INTEGER,"
                        " PRIMARY KEY (res, src, m, t)) WITHOUT ROWID")
        self.db.execute("CREATE INDEX IF NOT EXISTS series_t ON series (res, t)")
        self.db.execute("CREATE TABLE IF NOT EXISTS sources (src TEXT PRIMARY KEY, name TEXT, type TEXT, lat REAL, lon REAL, first INTEGER, last INTEGER)")
        self.db.execute("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)")
        self.db.commit()
        self.cur: dict[tuple[str, str], list] = {}      # this minute: (src, m) -> [sum, min, max, n]
        self.minute = self._floor(time.time(), 60)
        self.src_seen: dict[str, dict] = {}              # sources touched this minute, written at flush

    @staticmethod
    def _floor(t: float, res: int) -> int:
        return int(t // res) * res

    # ---- in
    def add(self, src: str, m: str, v, t: float | None = None):
        if v is None:
            return
        v = float(v)
        if self._floor(t or time.time(), 60) != self.minute:
            self.flush(t)
        b = self.cur.get((src, m))
        if b is None:
            self.cur[(src, m)] = [v, v, v, 1]
        else:
            b[0] += v; b[1] = min(b[1], v); b[2] = max(b[2], v); b[3] += 1

    def source(self, src: str, **info):
        """A station's name / type / position (the latest wins); written with the minute's rows."""
        self.src_seen.setdefault(src, {}).update({k: v for k, v in info.items() if v is not None})

    def flush(self, now: float | None = None):
        """Write the minute just ended (if it had anything), refresh its 15-min and 1-hour buckets, prune. Called by
        add() as a new minute starts and by the bridge's once-a-minute sampler, so a quiet minute is written too."""
        now = now or time.time()
        minute, rows = self.minute, self.cur
        self.minute, self.cur = self._floor(now, 60), {}
        seen, self.src_seen = self.src_seen, {}
        if not rows and not seen:
            return
        db = self.db
        db.executemany("INSERT OR REPLACE INTO series VALUES (60, ?, ?, ?, ?, ?, ?, ?)",
                       [(minute, s, m, b[0] / b[3], b[1], b[2], b[3]) for (s, m), b in rows.items()])
        for src, info in seen.items():
            db.execute("INSERT INTO sources (src, first, last) VALUES (?, ?, ?) ON CONFLICT(src) DO UPDATE SET last = excluded.last",
                       (src, minute, minute))
            for k in ("name", "type", "lat", "lon"):
                if k in info:
                    db.execute(f"UPDATE sources SET {k} = ? WHERE src = ?", (info[k], src))
        for (res, _), (fine, _) in zip(RES[1:], RES[:-1]):
            b = self._floor(minute, res)
            db.execute("INSERT OR REPLACE INTO series SELECT ?, ?, src, m, SUM(avg * n) / SUM(n), MIN(mn), MAX(mx), SUM(n) FROM series"
                       " WHERE res = ? AND t >= ? AND t < ? GROUP BY src, m", (res, b, fine, b, b + res))
        for res, keep in RES:
            db.execute("DELETE FROM series WHERE res = ? AND t < ?", (res, now - keep))
        n = db.execute("SELECT COUNT(*) FROM series").fetchone()[0]
        if n > MAX_ROWS:
            self._trim(n - MAX_ROWS)
        db.execute("DELETE FROM sources WHERE src NOT IN (SELECT src FROM sources ORDER BY last DESC LIMIT ?)", (MAX_SOURCES,))
        db.commit()

    def _trim(self, extra: int):
        """Over MAX_ROWS: drop the oldest 1-minute rows first, then 15-minute, then hourly (WITHOUT ROWID: by time)."""
        for res, _ in RES:
            if extra <= 0:
                return
            n = self.db.execute("SELECT COUNT(*) FROM series WHERE res = ?", (res,)).fetchone()[0]
            cut = self.db.execute("SELECT t FROM series WHERE res = ? ORDER BY t LIMIT 1 OFFSET ?", (res, extra - 1)).fetchone() if extra < n else None
            gone = self.db.execute("DELETE FROM series WHERE res = ? AND t <= ?" if cut else "DELETE FROM series WHERE res = ? AND ?",
                                   (res, cut[0] if cut else 1)).rowcount
            extra -= gone

    # ---- out
    def pick_res(self, frm: float, to: float, now: float | None = None) -> int:
        now = now or time.time()
        for res, keep in RES:
            if frm >= now - keep - res and (to - frm) / res <= MAX_POINTS:
                return res
        return RES[-1][0]

    def query(self, src: str, metrics: list[str], frm: float, to: float, res: int | None = None) -> dict:
        """{res, from, to, series: {metric: [[t_ms, avg, min, max, n], ...]}} -- times are bucket starts."""
        res = res if res in {r for r, _ in RES} else self.pick_res(frm, to)
        out: dict[str, list] = {m: [] for m in metrics}
        if metrics:
            q = ",".join("?" * len(metrics))
            for m, t, a, mn, mx, n in self.db.execute(f"SELECT m, t, avg, mn, mx, n FROM series WHERE res = ? AND src = ? AND m IN ({q})"
                                                      " AND t >= ? AND t <= ? ORDER BY t", (res, src, *metrics, int(frm) - res, int(to))):
                out[m].append([t * 1000, round(a, 3), round(mn, 3), round(mx, 3), n])
        return {"res": res, "from": int(frm * 1000), "to": int(to * 1000), "src": src, "series": out}

    def coverage(self, frm: float, to: float) -> list[dict]:
        """Stations heard DIRECT (metric snr0) between frm and to that have a position: average / best SNR and how often --
        the honest part of a coverage map (a relayed packet's SNR is the last repeater's, not the station's)."""
        res = self.pick_res(frm, to)
        rows = self.db.execute("SELECT s.src, s.name, s.type, s.lat, s.lon, SUM(x.avg * x.n) / SUM(x.n), MAX(x.mx), MIN(x.mn), SUM(x.n), MAX(x.t) "
                               "FROM series x JOIN sources s ON s.src = x.src WHERE x.res = ? AND x.m = 'snr0' AND x.t >= ? AND x.t <= ? "
                               "AND s.lat IS NOT NULL GROUP BY s.src", (res, int(frm) - res, int(to))).fetchall()
        return [{"src": r[0], "name": r[1], "type": r[2], "lat": r[3], "lon": r[4], "snr": round(r[5], 2), "best": round(r[6], 2),
                 "worst": round(r[7], 2), "n": r[8], "last": r[9] * 1000} for r in rows]

    def sources(self) -> list[dict]:
        """Every source with its metrics (from the hourly rows plus the last 48 h), newest first."""
        mets: dict[str, set] = {}
        for src, m in self.db.execute("SELECT DISTINCT src, m FROM series WHERE res IN (60, 3600)"):
            mets.setdefault(src, set()).add(m)
        out = []
        for src, name, typ, lat, lon, first, last in self.db.execute("SELECT src, name, type, lat, lon, first, last FROM sources ORDER BY last DESC"):
            out.append({k: v for k, v in {"src": src, "name": name, "type": typ, "lat": lat, "lon": lon, "first": first * 1000,
                                          "last": last * 1000, "metrics": sorted(mets.pop(src, ()))}.items() if v is not None})
        for src, ms in mets.items():          # e.g. "self", which has no sources row unless named
            out.insert(0, {"src": src, "metrics": sorted(ms)})
        return out

    # ---- upload to the P25X gateway (Phase 4b, --mesh-history-upload): what the gateway hasn't had yet, oldest first.
    # The watermark ("uploaded", a bucket start) lives in this file, so a gateway or bridge outage just means a bigger
    # batch next time. 1-minute rows are kept 48 h: a gap longer than that is filled from the 15-minute rows instead.
    UPLOAD_BATCH = 1500

    def meta(self, k: str, v=None):
        if v is None:
            r = self.db.execute("SELECT v FROM meta WHERE k = ?", (k,)).fetchone()
            return r[0] if r else None
        self.db.execute("INSERT OR REPLACE INTO meta VALUES (?, ?)", (k, str(v))); self.db.commit()

    def pending(self, now: float | None = None, limit: int | None = None) -> tuple[list, int]:
        """(rows, upto): rows [res, t, src, m, avg, mn, mx, n] newer than the watermark, whole buckets only; upto = the
        watermark to store once the gateway has them. First use starts 48 h back (all the 1-minute data there is)."""
        now, limit = now or time.time(), limit or self.UPLOAD_BATCH
        wm = int(float(self.meta("uploaded") or 0)) or int(now - RES[0][1])
        rows, upto = [], wm
        oldest = self.db.execute("SELECT MIN(t) FROM series WHERE res = 60").fetchone()[0]
        if oldest is not None and wm < oldest - 60:                 # older than the 1-minute rows go back: 15-minute rows
            rows = [[900, *r] for r in self.db.execute("SELECT t, src, m, avg, mn, mx, n FROM series WHERE res = 900 AND t > ? "
                                                       "AND t + 900 <= ? ORDER BY t LIMIT ?", (wm, oldest, limit))]
            if rows:
                upto = rows[-1][1] + 840                                # the 15-minute bucket's last minute
        if len(rows) < limit:
            more = [[60, *r] for r in self.db.execute("SELECT t, src, m, avg, mn, mx, n FROM series WHERE res = 60 AND t > ? "
                                                      "ORDER BY t LIMIT ?", (max(upto, wm), limit - len(rows) + 1))]
            if len(more) > limit - len(rows):                            # cut at a whole minute: drop the last, partly-read one
                last = more[-1][1]; cut = [r for r in more if r[1] != last]
                more = cut if cut or rows else [[60, *r] for r in self.db.execute(   # one minute bigger than a batch: all of it
                    "SELECT t, src, m, avg, mn, mx, n FROM series WHERE res = 60 AND t = ?", (last,))]
            rows += more
            if more:
                upto = max(upto, more[-1][1])
        return rows, upto

    def names(self, srcs) -> dict:
        q = list(set(srcs))[:500]
        if not q:
            return {}
        return {r[0]: {"name": r[1], "type": r[2]} for r in self.db.execute(
            f"SELECT src, name, type FROM sources WHERE src IN ({','.join('?' * len(q))})", q) if r[1]}

    def close(self):
        self.flush()
        self.db.close()
