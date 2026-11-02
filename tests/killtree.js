/* Kelly Page tests -- end a spawned browser and everything it started. On Windows child.kill() ends only the process
 * spawn() returned, and msedge.exe may hand off to a fresh browser process that isn't its child at all: the browser
 * and its GPU process (software rendering, a full core each) run on after the test, and a full suite starves the
 * machine until later tests fail at random ("browser did not start", timeouts -- 208 left over on 2026-10-23).
 * So on Windows: the process tree, then every browser process started with this test's --user-data-dir. */
'use strict';
const { spawnSync } = require('child_process');
module.exports = function killTree(child, profile) {
  if (process.platform !== 'win32') { if (child && child.exitCode === null) child.kill(); return; }
  if (child && child.exitCode === null) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  if (!profile) return;
  const dir = String(profile).replace(/'/g, "''");
  spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
    `Get-CimInstance Win32_Process -Filter "Name='msedge.exe' OR Name='chrome.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${dir}') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`],
  { stdio: 'ignore', timeout: 20000 });
};
