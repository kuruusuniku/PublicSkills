'use strict';

// herdr のクライアントを表示しているターミナルを最前面に出す (別デスクトップ/Space にあっても切り替わる)。
// ターミナル名を設定していなければ、herdr クライアントのプロセスから親をたどってアプリを特定する。

const { execFile } = require('node:child_process');

function run(cmd, args, timeout = 5000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(String(stdout));
    });
  });
}

// よく使われるターミナル。親をたどっても見つからない (tmux の中など) ときは、起動中のものから選ぶ。
const KNOWN_TERMINALS = ['Ghostty', 'iTerm', 'WezTerm', 'kitty', 'Alacritty', 'Warp', 'Terminal'];

function bundleOf(comm) {
  // ヘルパー (例: VS Code の Code Helper.app) の内側にいても、一番外側の .app を返す
  if (comm.indexOf('.app/Contents/') <= 0) return null;
  return comm.slice(0, comm.indexOf('.app/') + 4);
}

// `ps -axo pid=,ppid=,comm=` の出力から、herdr クライアントの祖先にあるターミナルの .app を探す。
// macOS の comm は実行ファイルのフルパスなので /Applications/Ghostty.app/Contents/MacOS/ghostty のように見える。
function findAppBundle(psOutput) {
  const procs = new Map();
  for (const line of psOutput.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (m) procs.set(Number(m[1]), { ppid: Number(m[2]), comm: m[3].trim() });
  }
  for (const [pid, proc] of procs) {
    if (proc.comm.split('/').pop() !== 'herdr') continue;
    let cur = procs.get(proc.ppid);
    for (let depth = 0; cur && depth < 16; depth += 1) {
      // iTerm2 のシェルは launchd 直下の iTermServer の子なので、アプリ本体まで辿れない
      if (/\/iTermServer[^/]*$/.test(cur.comm)) return 'iTerm';
      const bundle = bundleOf(cur.comm);
      if (bundle) return bundle;
      if (cur.ppid === pid || cur.ppid <= 1) break;
      cur = procs.get(cur.ppid);
    }
  }
  const running = new Set([...procs.values()].map((p) => bundleOf(p.comm)).filter(Boolean).map((b) => b.split('/').pop().replace(/\.app$/, '')));
  return KNOWN_TERMINALS.find((name) => running.has(name)) || null;
}

async function raiseMac(terminalApp) {
  let app = terminalApp;
  if (!app) app = findAppBundle(await run('ps', ['-axo', 'pid=,ppid=,comm=']));
  if (!app) throw new Error('herdr を表示しているターミナルが見つかりません (config の deck.terminalApp で指定できます)');
  await run('open', ['-a', app]);
  return app;
}

// Windows: herdr.exe の親をたどって最初にウィンドウを持つプロセス (Windows Terminal など) を前面へ。
// SetForegroundWindow は他アプリからの前面化を拒否することがあるため、Alt キーを一瞬押して許可を得る定番の手を使う。
function windowsScript(preferName) {
  const prefer = String(preferName || '').replace(/\.exe$/i, '').replace(/'/g, "''");
  return `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -Namespace HerdrDeck -Name Win -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
[DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int cmd);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
[DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
'@
$target = $null
$prefer = '${prefer}'
if ($prefer) { $target = Get-Process -Name $prefer | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1 }
if (-not $target) {
  $procs = @{}
  Get-CimInstance Win32_Process | ForEach-Object { $procs[[int]$_.ProcessId] = $_ }
  foreach ($h in ($procs.Values | Where-Object { $_.Name -ieq 'herdr.exe' })) {
    $cur = $procs[[int]$h.ParentProcessId]
    for ($i = 0; $cur -and $i -lt 16; $i++) {
      $p = Get-Process -Id $cur.ProcessId
      if ($p -and $p.MainWindowHandle -ne 0) { $target = $p; break }
      $cur = $procs[[int]$cur.ParentProcessId]
    }
    if ($target) { break }
  }
}
if (-not $target) { $target = Get-Process -Name WindowsTerminal | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1 }
if (-not $target) { exit 3 }
$hwnd = $target.MainWindowHandle
if ([HerdrDeck.Win]::IsIconic($hwnd)) { [void][HerdrDeck.Win]::ShowWindowAsync($hwnd, 9) }
[HerdrDeck.Win]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
[void][HerdrDeck.Win]::SetForegroundWindow($hwnd)
[HerdrDeck.Win]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
Write-Output $target.ProcessName
`;
}

// スクリプトは -EncodedCommand (UTF-16LE の base64) で渡す。-Command だと Windows のコマンドライン
// 引用規則で " が崩れることがある。
function encodePowerShell(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

async function raiseWindows(terminalApp) {
  const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodePowerShell(windowsScript(terminalApp))], 15000)
    .catch((err) => {
      if (err.code === 3) throw new Error('herdr を表示しているターミナルが見つかりません (config の deck.terminalApp で指定できます)');
      throw err;
    });
  return out.trim();
}

async function raiseLinux(terminalApp) {
  // VSD Craft は Linux 非対応だが、動作確認用に wmctrl があれば使う。
  if (!terminalApp) return null;
  await run('wmctrl', ['-x', '-a', terminalApp]);
  return terminalApp;
}

function raiseTerminal(terminalApp, platform = process.platform) {
  if (platform === 'darwin') return raiseMac(terminalApp);
  if (platform === 'win32') return raiseWindows(terminalApp);
  return raiseLinux(terminalApp);
}

module.exports = { raiseTerminal, findAppBundle, windowsScript, encodePowerShell };
