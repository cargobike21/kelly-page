"""Kelly's awards, shared between a member's Kellys (the PC and the phone) through their Kelly bridge (2026-10-23).

GET /api/kelly-state -> {key: value}; POST /api/kelly-state {key: value} merges in and answers the merged state.
Only the award stores in KEYS travel. The page twin is kelly-page/js/statesync.js: same KEYS, same merge rule, and
both test suites run the vectors in kelly_state_vectors.json.

The merge never loses an award: two Kellys that earned different badges both end up with both.
  dicts recurse key by key; numbers -> the higher (XP is the higher of the two, not the sum: the same XP may be on both);
  'first' / 'hops' -> the lower; bools -> or; strings -> the later (ISO dates compare right);
  a dict for one day ({day: ...} / rtty's {d: ...}) whose days differ -> the later day's dict whole (today's missions);
  streak {n, best, last} -> the later 'last' whole, best = the higher; meshQuest records (recs.<key>) -> the better
  value (lower for deep / rtt); Golden Packet tokens (tokens.<id>) -> the higher seq, then the later; a leaderboard
  snapshot (board) -> the later; lists -> union (by 'id' / 'key' when the items carry one, merging the pair), by time
  when the items carry t / at, capped at 500; null or missing -> the other side.
  bleGames.fox (the fox hunt's settings and a run in progress) stays as each Kelly has it.
'profile' (2026-10-24) is the station's details, not an award: {v: {field: value}, at: {field: ms}}, and the newer
'at' wins field by field (a tie keeps the copy already here).
Stdlib only."""
from __future__ import annotations

import json
import os
import time
from pathlib import Path

KEYS = ("meshQuest", "meshGold", "meshQuest2", "meshGold2", "rttyQuest", "fireQuest", "issQuest", "swQuest", "bleGames", "profile")
MAX_BODY = 512 * 1024          # a POST
MAX_VALUE = 256 * 1024         # one store, as JSON
CAP = 500                      # a list
DAY_KEYS = ("day", "d")
MIN_KEYS = ("first", "hops")
LOWER_BETTER = ("deep", "rtt")  # meshfun.js LOWER_BETTER: a record that is better lower
LOCAL_ONLY = (("bleGames", "fox"),)


def _num(x):
    return isinstance(x, (int, float)) and not isinstance(x, bool)


def _canon(x) -> str:
    return json.dumps(x, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def _tkey(x):
    for k in ("t", "at"):
        if isinstance(x, dict) and _num(x.get(k)):
            return x[k]
    return None


def _merge_list(a: list, b: list, path: tuple) -> list:
    idk = next((k for k in ("id", "key") if a + b and all(isinstance(x, dict) and k in x for x in a + b)), None)
    if idk:
        out, at = [], {}
        for x in a + b:
            i = _canon(x[idk])
            if i in at:
                out[at[i]] = merge(out[at[i]], x, path + (str(x[idk]),))
            else:
                at[i] = len(out); out.append(x)
    else:
        seen, out = set(), []
        for x in a + b:
            c = _canon(x)
            if c not in seen:
                seen.add(c); out.append(x)
    times = [_tkey(x) for x in out]
    if out and all(t is not None for t in times):
        ref = a if len(a) > 1 else b
        desc = len(ref) > 1 and _tkey(ref[0]) >= _tkey(ref[-1])
        out.sort(key=_tkey, reverse=desc)
        return out[:CAP] if desc else out[-CAP:]
    return out[-CAP:]


def _merge_profile(a: dict, b: dict) -> dict:
    """The station's details: per field, the side changed last ('at', ms); a tie keeps a."""
    av, aa, bv, ba = a.get("v") or {}, a.get("at") or {}, b.get("v") or {}, b.get("at") or {}
    v, at = {}, {}
    for f in list(av) + [f for f in bv if f not in av]:
        use_a = f in av and (f not in bv or (aa.get(f) or 0) >= (ba.get(f) or 0))
        v[f], at[f] = (av[f], aa.get(f) or 0) if use_a else (bv[f], ba.get(f) or 0)
    return {"v": v, "at": at}


def merge(a, b, path: tuple = ()):
    """Two copies of one store (or a part of one) -> one copy holding everything both earned."""
    if a is None:
        return b
    if b is None:
        return a
    if path == ("profile",) and isinstance(a, dict) and isinstance(b, dict):
        return _merge_profile(a, b)
    if path in LOCAL_ONLY:
        return a
    key = path[-1] if path else ""
    parent = path[-2] if len(path) > 1 else ""
    if isinstance(a, bool) and isinstance(b, bool):
        return a or b
    if _num(a) and _num(b):
        return min(a, b) if key in MIN_KEYS else max(a, b)
    if isinstance(a, str) and isinstance(b, str):
        return max(a, b)
    if isinstance(a, list) and isinstance(b, list):
        return _merge_list(a, b, path)
    if not (isinstance(a, dict) and isinstance(b, dict)):
        return b if type(a) is not type(b) else a
    if parent == "recs" and _num(a.get("v")) and _num(b.get("v")):
        lower = key in LOWER_BETTER
        if a["v"] == b["v"]:
            return a if (a.get("at") or 0) <= (b.get("at") or 0) else b   # the first to get there
        return a if (a["v"] < b["v"]) == lower else b
    if parent == "tokens":
        ka, kb = (a.get("seq") or 0, a.get("at") or 0), (b.get("seq") or 0, b.get("at") or 0)
        return a if ka >= kb else b
    if key == "board":
        return a if (a.get("got") or a.get("at") or 0) >= (b.get("got") or b.get("at") or 0) else b
    if key == "streak" and "last" in a and "last" in b:
        out = dict(a if str(a.get("last") or "") >= str(b.get("last") or "") else b)
        if _num(a.get("best")) or _num(b.get("best")):
            out["best"] = max(a.get("best") or 0, b.get("best") or 0)
        return out
    for dk in DAY_KEYS:
        if isinstance(a.get(dk), str) and isinstance(b.get(dk), str) and a[dk] != b[dk]:
            return a if a[dk] > b[dk] else b
    out = {}
    for k in list(a) + [k for k in b if k not in a]:
        out[k] = merge(a.get(k), b.get(k), path + (k,))
    return out


class KellyState:
    """The bridge's copy: {key: value} for KEYS, kept in FILE (0600, written atomically, at most every SAVE_GAP_S)."""
    SAVE_GAP_S = 3.0

    def __init__(self, path: str | Path | None):
        self.path = Path(path).expanduser() if path else None
        self.state: dict = {}
        self._saved_at, self._pending = 0.0, False
        if self.path and self.path.exists():
            try:
                d = json.loads(self.path.read_text(encoding="utf-8"))
                self.state = {k: v for k, v in d.items() if k in KEYS} if isinstance(d, dict) else {}
            except (OSError, ValueError) as e:
                print(f"[bridge] kelly-state: couldn't read {self.path}: {e}", flush=True)

    def put(self, incoming: dict, loop=None) -> dict:
        """Merge a Kelly's stores in (unknown keys and oversize values left out) and return the merged state."""
        if not isinstance(incoming, dict):
            raise ValueError("expected {key: value}")
        for k, v in incoming.items():
            if k not in KEYS or v is None or len(_canon(v)) > MAX_VALUE:
                continue
            self.state[k] = merge(self.state.get(k), v, (k,))
        self.save_soon(loop)
        return self.state

    def save_soon(self, loop=None):
        wait = self.SAVE_GAP_S - (time.time() - self._saved_at)
        if wait <= 0 or loop is None:
            self.save()
        elif not self._pending:
            self._pending = True
            loop.call_later(wait, self.save)

    def save(self):
        self._pending, self._saved_at = False, time.time()
        if not self.path:
            return
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_name(self.path.name + ".tmp")
            tmp.write_text(json.dumps(self.state), encoding="utf-8")
            try:
                os.chmod(tmp, 0o600)
            except OSError:
                pass
            os.replace(tmp, self.path)
        except OSError as e:
            print(f"[bridge] kelly-state: can't keep it in {self.path}: {e}", flush=True)
