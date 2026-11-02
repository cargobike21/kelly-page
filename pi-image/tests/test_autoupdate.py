"""Tests for the Pi auto-updater (kellypage-autoupdate) and scripts/sign_release.py, with fakes (no network, no systemd).
Run:  .venv\\Scripts\\python.exe -m unittest discover -s kelly-page/pi-image/tests -v
Uses a fixed TEST seed (bytes 0..31); the real release key is never involved.
"""
import hashlib
import importlib.machinery
import json
import importlib.util
import os
import sys
import tempfile
import time
import zipfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
PI = HERE.parent
ROOT = PI.parent.parent
sys.path.insert(0, str(PI / "rootfs/usr/local/lib/kellypage"))
sys.path.insert(0, str(ROOT / "scripts"))
import kpu1  # noqa: E402
import sign_release  # noqa: E402

try:
    import fcntl  # noqa: F401
except ImportError:  # Windows: the updater only runs on the Pi; give it a no-op lock for the tests
    import types
    fake = types.ModuleType("fcntl")
    fake.LOCK_EX, fake.LOCK_NB, fake.flock = 2, 4, lambda *a: None
    sys.modules["fcntl"] = fake

_loader = importlib.machinery.SourceFileLoader("kpau", str(PI / "rootfs/usr/local/sbin/kellypage-autoupdate"))
_spec = importlib.util.spec_from_loader("kpau", _loader)
kpau = importlib.util.module_from_spec(_spec)
_loader.exec_module(kpau)

SEED = bytes(range(32))
OTHER = bytes(range(1, 33))
PUB = bytes.fromhex(kpu1.public_hex(SEED))
ZIP = b"PK-fake-zip-contents" * 50


def manifest(version="0.4.50", channel="stable", product="kellypage-pi", kid="rel-2026a", seed=SEED, zipdata=ZIP,
             min_from="", name="KellyPage-x.zip", sha=None, size=None, at=None, expires=None):
    p = {"v": 1, "kid": kid, "product": product, "version": version, "min_from": min_from, "channel": channel,
         "files": [{"name": name, "url": "https://downloads.kellypage.app/" + name,
                    "sha256": sha or hashlib.sha256(zipdata).hexdigest(), "size": size or len(zipdata)}],
         "notes_url": "", "at": at or time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    if expires is not None:
        p["expires"] = expires
    return kpu1.sign(p, seed)


class Env:
    """A fake Pi: temp config/keys/version files, a fake network, recorded update/rollback/health calls."""

    def __init__(self, tc, token, installed="0.4.40", enabled="1", channel="stable", zipdata=ZIP, health=True,
                 update_rc=0, bad=None, keyset=None, after=None):
        self.d = tempfile.TemporaryDirectory()
        d = Path(self.d.name)
        tc.addCleanup(self.d.cleanup)
        (d / "conf").write_text("ENABLED=%s\nCHANNEL=%s\n" % (enabled, channel))
        import json
        (d / "keys").write_text(json.dumps({"keys": keyset or {"rel-2026a": PUB.hex()}}))
        (d / "version.js").write_text("window.KELLY_VERSION = '%s';\n" % installed)
        if bad:
            (d / "bad").write_text("\n".join(bad) + "\n")
        self.paths = dict(conf=str(d / "conf"), keys=str(d / "keys"), bad=str(d / "bad"), version=str(d / "version.js"),
                          lock=str(d / "lock"), tmp=str(d))
        self.calls = []
        self.fetched = []

        def getter(url, limit):
            self.fetched.append(url)
            if url.endswith(".kpu1"):
                return token.encode("ascii")
            return zipdata
        self.getter = getter

        def update(path):
            self.calls.append(("update", os.path.basename(path)))
            if update_rc == 0:   # a real kellypage-update replaces /opt/kelly-page: the version file changes
                v = after or json.loads(kpu1.unb64u(token.split(".")[1]))["version"]
                (d / "version.js").write_text("window.KELLY_VERSION = '%s';\n" % v)
            return update_rc
        self.update = update
        def rollback():
            self.calls.append(("rollback",))
            (d / "version.js").write_text("window.KELLY_VERSION = '%s';\n" % installed)
            return 0
        self.rollback = rollback
        self.health = lambda: (self.calls.append(("health",)) or health)
        self.bad_file = d / "bad"

    def run(self, argv=()):
        return kpau.main(list(argv), getter=self.getter, update=self.update, rollback=self.rollback,
                         health=self.health, paths=self.paths)

    def bad(self):
        return self.bad_file.read_text().split() if self.bad_file.exists() else []


class UpdaterTests(unittest.TestCase):
    def test_valid_update_applied(self):
        e = Env(self, manifest())
        self.assertEqual(e.run(), kpau.OK)
        self.assertEqual(e.calls, [("update", "KellyPage-x.zip"), ("health",)])
        self.assertEqual(e.bad(), [])

    def test_disabled_does_nothing_and_force_overrides(self):
        e = Env(self, manifest(), enabled="0")
        self.assertEqual(e.run(), kpau.OK)
        self.assertEqual(e.fetched, [])
        self.assertEqual(e.run(["--force"]), kpau.OK)
        self.assertIn(("update", "KellyPage-x.zip"), e.calls)

    def test_up_to_date(self):
        e = Env(self, manifest(version="0.4.40"))
        self.assertEqual(e.run(), kpau.OK)
        self.assertEqual(e.calls, [])

    def test_check_only_installs_nothing(self):
        e = Env(self, manifest())
        self.assertEqual(e.run(["--check"]), kpau.OK)
        self.assertEqual(e.calls, [])

    def test_default_url_follows_channel(self):
        e = Env(self, manifest(channel="beta"), channel="beta")
        e.run()
        self.assertEqual(e.fetched[0], "https://downloads.kellypage.app/kellypage-pi-beta.kpu1")

    def test_bad_signature_refused(self):
        e = Env(self, manifest(seed=OTHER))
        self.assertEqual(e.run(), kpau.EREFUSED)
        self.assertEqual(e.calls, [])

    def test_tampered_payload_refused(self):
        t = manifest()
        head, seg, sig = t.split(".")
        other = manifest(version="9.9.9").split(".")[1]
        e = Env(self, ".".join([head, other, sig]))
        self.assertEqual(e.run(), kpau.EREFUSED)

    def test_unknown_kid_refused(self):
        e = Env(self, manifest(kid="rel-2099z"))
        self.assertEqual(e.run(), kpau.EREFUSED)
        self.assertEqual(e.calls, [])

    def test_second_pinned_kid_accepted(self):
        pub2 = kpu1.public_hex(OTHER)
        e = Env(self, manifest(kid="rel-2027a", seed=OTHER),
                keyset={"rel-2026a": PUB.hex(), "rel-2027a": pub2})
        self.assertEqual(e.run(), kpau.OK)
        self.assertIn(("update", "KellyPage-x.zip"), e.calls)

    def test_bad_sha256_refused(self):
        e = Env(self, manifest(sha="0" * 64))
        self.assertEqual(e.run(), kpau.EREFUSED)
        self.assertEqual(e.calls, [])

    def test_size_mismatch_refused(self):
        e = Env(self, manifest(size=len(ZIP) + 5))
        self.assertEqual(e.run(), kpau.EREFUSED)
        self.assertEqual(e.calls, [])

    def test_downgrade_refused(self):
        e = Env(self, manifest(version="0.4.39"))
        self.assertEqual(e.run(), kpau.EREFUSED)
        self.assertEqual(e.calls, [])

    def test_wrong_channel_refused(self):
        e = Env(self, manifest(channel="beta"), channel="stable")
        self.assertEqual(e.run(), kpau.EREFUSED)

    def test_wrong_product_refused(self):
        e = Env(self, manifest(product="kellypage-zip"))
        self.assertEqual(e.run(), kpau.EREFUSED)

    def test_min_from_refused(self):
        e = Env(self, manifest(min_from="0.4.45"))
        self.assertEqual(e.run(), kpau.EREFUSED)
        e = Env(self, manifest(min_from="0.4.40"))
        self.assertEqual(e.run(), kpau.OK)

    def test_bad_version_refused(self):
        e = Env(self, manifest(), bad=["0.4.50"])
        self.assertEqual(e.run(), kpau.EREFUSED)
        self.assertEqual(e.calls, [])

    def test_install_failure_reported(self):
        e = Env(self, manifest(), update_rc=1)
        self.assertEqual(e.run(), kpau.EINSTALL)
        self.assertEqual(e.calls, [("update", "KellyPage-x.zip")])

    def test_health_failure_restores_and_records_bad(self):
        e = Env(self, manifest(), health=False)
        self.assertEqual(e.run(), kpau.EHEALTH)
        self.assertEqual(e.calls, [("update", "KellyPage-x.zip"), ("health",), ("rollback",)])
        self.assertEqual(e.bad(), ["0.4.50"])
        e.calls.clear()
        self.assertEqual(e.run(), kpau.EREFUSED)   # next day it is not retried
        self.assertEqual(e.calls, [])

    def test_rollback_failure_is_critical(self):
        e = Env(self, manifest(), health=False)
        e.rollback = lambda: 1
        self.assertEqual(e.run(), kpau.EROLLBACK)

    def test_install_failure_recorded_as_bad(self):
        e = Env(self, manifest(), update_rc=1)
        self.assertEqual(e.run(), kpau.EINSTALL)
        self.assertEqual(e.bad(), ["0.4.50"])

    def test_zip_version_differs_from_manifest_restores(self):
        e = Env(self, manifest(), after="0.4.77")
        self.assertEqual(e.run(), kpau.EHEALTH)
        self.assertEqual(e.calls, [("update", "KellyPage-x.zip"), ("rollback",)])
        self.assertEqual(e.bad(), ["0.4.50"])

    def test_expired_manifest_refused(self):
        e = Env(self, manifest(expires=int(time.time()) - 10))
        self.assertEqual(e.run(), kpau.EREFUSED)
        self.assertEqual(e.calls, [])
        e = Env(self, manifest(expires=int(time.time()) + 1000))
        self.assertEqual(e.run(), kpau.OK)

    def test_old_manifest_without_expires_refused(self):
        old = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - 401 * 86400))
        self.assertEqual(Env(self, manifest(at=old)).run(), kpau.EREFUSED)
        recent = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - 300 * 86400))
        self.assertEqual(Env(self, manifest(at=recent)).run(), kpau.OK)

    def test_lock_dir_created_and_symlink_lock_refused(self):
        e = Env(self, manifest())
        sub = os.path.join(e.d.name, "run", "kellypage")
        e.paths["lock"] = os.path.join(sub, "autoupdate.lock")
        self.assertEqual(e.run(), kpau.OK)
        self.assertTrue(os.path.exists(e.paths["lock"]))
        if hasattr(os, "O_NOFOLLOW"):
            os.remove(e.paths["lock"])
            target = os.path.join(e.d.name, "elsewhere")
            open(target, "w").close()
            os.symlink(target, e.paths["lock"])
            self.assertEqual(e.run(), kpau.EFETCH)

    def test_network_failure_changes_nothing(self):
        e = Env(self, manifest())
        e.getter = lambda url, limit: (_ for _ in ()).throw(OSError("offline"))
        self.assertEqual(e.run(), kpau.EFETCH)
        self.assertEqual(e.calls, [])

    def test_http_manifest_url_refused_by_fetcher(self):
        with self.assertRaises(OSError):
            kpau.http_get("http://example.org/x.kpu1", 100)


class SignReleaseTests(unittest.TestCase):
    def setUp(self):
        self.d = Path(tempfile.mkdtemp())
        self.addCleanup(lambda: __import__("shutil").rmtree(self.d, ignore_errors=True))
        self.zip = self.d / "KellyPage-0.4.50.zip"
        with zipfile.ZipFile(self.zip, "w") as zf:
            zf.writestr("Kelly Page/js/version.js", "window.KELLY_VERSION = '0.4.50';\n")
            zf.writestr("Kelly Page/index.html", "x" * 500)
        self.zipdata = self.zip.read_bytes()
        self.keyfile = self.d / "release-key"
        self.keyfile.write_text("# test\nKELLY_RELEASE_KEY_REL_2026A=%s\n" % SEED.hex())
        self.keys = self.d / "keys.json"
        self.keys.write_text('{"keys": {"rel-2026a": "%s"}}' % PUB.hex())
        for k in ("KELLY_RELEASE_PUB", "KELLY_RELEASE_KEY_FILE"):
            self.addCleanup(os.environ.pop, k, None)
            os.environ.pop(k, None)
        # the repo .env carries the REAL rel-2026a public key; pin the test key so sign_release never falls back to it
        os.environ["KELLY_RELEASE_PUB"] = PUB.hex()

    def sign(self, *extra, version="0.4.50"):
        return sign_release.main(["--version", version, "--channel", "stable", "--key-file", str(self.keyfile),
                                  "--keys", str(self.keys), *extra, str(self.zip)])

    def test_round_trip_and_updater_accepts(self):
        self.assertEqual(self.sign(), 0)
        out = self.d / "kellypage-pi-stable.kpu1"
        self.assertTrue(out.exists())
        self.assertEqual(sign_release.main(["--verify", str(out), "--keys", str(self.keys), str(self.zip)]), 0)
        p = kpu1.verify(out.read_text(), {"rel-2026a": PUB})
        self.assertEqual(p["files"][0]["sha256"], hashlib.sha256(self.zipdata).hexdigest())
        self.assertEqual(p["files"][0]["size"], len(self.zipdata))
        self.assertTrue(p["files"][0]["url"].startswith("https://downloads.kellypage.app/"))
        self.assertEqual(kpau.check_manifest(out.read_text(), {"rel-2026a": PUB}, "stable", "0.4.40", set())[1]["name"],
                         self.zip.name)

    def test_verify_detects_changed_zip(self):
        self.sign()
        self.zip.write_bytes(self.zipdata + b"x")
        out = self.d / "kellypage-pi-stable.kpu1"
        self.assertEqual(sign_release.main(["--verify", str(out), "--keys", str(self.keys), str(self.zip)]), 1)

    def _rezip(self, version):
        with zipfile.ZipFile(self.zip, "w") as zf:
            zf.writestr("Kelly Page/js/version.js", "window.KELLY_VERSION = '%s';\n" % version)

    def test_refuses_version_not_greater_than_previous(self):
        self.assertEqual(self.sign(), 0)
        prev = self.d / "kellypage-pi-stable.kpu1"
        with self.assertRaises(SystemExit):
            self.sign("--previous", str(prev))
        self._rezip("0.4.51")
        self.assertEqual(self.sign("--previous", str(prev), version="0.4.51"), 0)

    def test_version_defaults_to_zip_and_must_match(self):
        self.assertEqual(sign_release.main(["--channel", "stable", "--key-file", str(self.keyfile),
                                            "--keys", str(self.keys), str(self.zip)]), 0)
        p = kpu1.verify((self.d / "kellypage-pi-stable.kpu1").read_text(), {"rel-2026a": PUB})
        self.assertEqual(p["version"], "0.4.50")
        with self.assertRaises(SystemExit):
            self.sign(version="0.4.99")

    def test_non_kelly_zip_refused(self):
        other = self.d / "other.zip"
        with zipfile.ZipFile(other, "w") as zf:
            zf.writestr("a.txt", "x")
        with self.assertRaises(SystemExit):
            sign_release.main(["--channel", "stable", "--key-file", str(self.keyfile), "--keys", str(self.keys), str(other)])

    def test_expires_written(self):
        self.assertEqual(self.sign("--expires-days", "30"), 0)
        p = kpu1.verify((self.d / "kellypage-pi-stable.kpu1").read_text(), {"rel-2026a": PUB})
        self.assertAlmostEqual(p["expires"], time.time() + 30 * 86400, delta=120)

    def test_pub_mismatch_refused_and_seed_not_printed(self):
        os.environ["KELLY_RELEASE_PUB"] = "00" * 32
        import io, contextlib
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):
            with self.assertRaises(SystemExit) as cm:
                self.sign()
        self.assertNotIn(SEED.hex(), buf.getvalue())
        self.assertNotIn(SEED.hex(), str(cm.exception))
        os.environ["KELLY_RELEASE_PUB"] = PUB.hex()
        self.assertEqual(self.sign(), 0)


if __name__ == "__main__":
    unittest.main()
