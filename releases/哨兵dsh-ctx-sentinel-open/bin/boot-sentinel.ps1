# 上下文哨兵 · 开机自启（Windows 登录时由「启动」文件夹里的快捷方式隐藏调用）
#
#   1. 扫所有在跑的哨兵进程（命令行含 ctx-sentinel.js 的 node），不只看 pidfile——
#      pidfile 只能记住一个 pid，历史上留过别的 pidfile、或者手动起过一次，
#      就会有多个实例同时跑：它们轮流写同一份状态文件，谁也改不动配置。
#      实测过三个实例互相把状态打回旧值，所以这里以「扫进程」为准。
#   2. 发现多个 -> 只留最早启动的那个，其余强制结束，并把 pidfile 修正过去。
#   3. 一个都没有 -> 找一个能用的 Node（安装时记下的路径 -> DSH 自带运行时 ->
#      常见安装位置，逐个验证支持 zlib.zstdDecompressSync），隐藏窗口拉起。
#   4. 本脚本跑完就退出，哨兵留在后台；重复运行安全（幂等）。
#
# 输出日志：%USERPROFILE%\.dsh\logs\ctx-sentinel.boot.log（和主日志同目录）

$ErrorActionPreference = 'SilentlyContinue'

$UserHome  = $env:USERPROFILE
$DshHome   = Join-Path $UserHome '.dsh'
$LogFile   = Join-Path $DshHome 'logs\ctx-sentinel.log'
$BootLog   = Join-Path $DshHome 'logs\ctx-sentinel.boot.log'
$OutLog    = Join-Path $DshHome 'logs\ctx-sentinel.out.log'
$Sentinel  = Join-Path $DshHome 'plugins\dsh-ctx-sentinel\sentinel\ctx-sentinel.js'
$PidFile   = Join-Path $DshHome 'ctx-sentinel.pid'
$NodeRec   = Join-Path $DshHome 'sentinel-node.txt'
$Runner    = Join-Path $PSScriptRoot 'run-sentinel.cmd'

function Write-Boot([string]$msg) {
  $line = '{0} [boot] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
  $dir = Split-Path $LogFile -Parent
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  # 先写主日志；万一主日志被别人占着（比如 DSH 还攥着旧句柄），退到 boot 日志，
  # 不让一句日志写不进去把整条自启链拖垮。
  foreach ($f in @($LogFile, $BootLog)) {
    try {
      Add-Content -Path $f -Value $line -Encoding UTF8 -ErrorAction Stop
      return
    } catch { }
  }
}

# 找出所有在跑的哨兵进程：node.exe 且命令行含 ctx-sentinel.js。
# 返回 @{ pid; started } 数组，按启动时间升序（最早的在前面 = 最可能是正主）。
# CIM 用不了时退回 pidfile（至少不会因为读不到进程表就重复拉起）。
function Get-SentinelProcesses {
  $found = New-Object System.Collections.Generic.List[object]

  $procs = $null
  try {
    $procs = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction Stop
  } catch { $procs = $null }

  if ($procs) {
    foreach ($p in $procs) {
      $cmd = [string]$p.CommandLine
      if (-not $cmd) { continue }
      if ($cmd -notlike '*ctx-sentinel.js*') { continue }
      $started = $null
      try { $started = $p.CreationDate } catch { $started = $null }
      $found.Add([pscustomobject]@{ pid = [int]$p.ProcessId; started = $started })
    }
  } else {
    # 退回：只看 pidfile 记录的那一个
    if (Test-Path $PidFile) {
      try {
        $info = Get-Content $PidFile -Raw | ConvertFrom-Json
        $procId = [int]$info.pid
        if ($procId -gt 0) {
          $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
          if ($proc) {
            $started = $null
            try { $started = $proc.StartTime } catch { $started = $null }
            $found.Add([pscustomobject]@{ pid = $procId; started = $started })
          }
        }
      } catch { }
    }
  }

  # 没有启动时间的排到最后，避免 Sort-Object 把 $null 当最早
  return @($found | Sort-Object -Property @{ Expression = { if ($_.started) { $_.started } else { [datetime]::MaxValue } } })
}

# 把 pidfile 修正成指定的 pid（哨兵自己也会写，这里只是确保多实例清理后指向正确）
function Set-PidFile([int]$procId) {
  try {
    $tmp = "$PidFile.tmp"
    $json = ConvertTo-Json @{ pid = $procId; at = (Get-Date).ToString('o') } -Compress
    Set-Content -Path $tmp -Value $json -Encoding UTF8 -ErrorAction Stop
    Move-Item -Path $tmp -Destination $PidFile -Force -ErrorAction Stop
  } catch { }
}

# 逐个候选试 zstd，返回第一个能用的
function Find-ZstdNode {
  $cands = New-Object System.Collections.Generic.List[string]

  if (Test-Path $NodeRec) {
    foreach ($line in (Get-Content $NodeRec)) { if ($line -and $line.Trim()) { $cands.Add($line.Trim()) } }
  }
  $rt = Join-Path $DshHome 'dsh-runtimes'
  if (Test-Path $rt) {
    foreach ($d in (Get-ChildItem $rt -Directory)) {
      $cands.Add((Join-Path $d.FullName 'dependencies\node\bin\node.exe'))
    }
  }
  $cands.Add((Join-Path $env:ProgramFiles 'nodejs\node.exe'))

  foreach ($exe in $cands) {
    if (-not $exe) { continue }
    if (-not (Test-Path $exe)) { continue }
    & $exe -e "process.exit(require('zlib').zstdDecompressSync?0:1)" 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { return $exe }
  }
  return $null
}

if (-not (Test-Path $Sentinel)) { Write-Boot "找不到哨兵脚本：$Sentinel"; exit 1 }
if (-not (Test-Path $Runner))   { Write-Boot "找不到启动器：$Runner"; exit 1 }

# ---- 幂等判断：以扫进程为准，顺手清理重复实例 ----
$running = @(Get-SentinelProcesses)

if ($running.Count -ge 2) {
  $keep = $running[0]
  $killed = New-Object System.Collections.Generic.List[int]
  foreach ($extra in ($running | Select-Object -Skip 1)) {
    try {
      Stop-Process -Id $extra.pid -Force -ErrorAction Stop
      $killed.Add($extra.pid)
    } catch {
      Write-Boot "结束重复实例 pid $($extra.pid) 失败：$($_.Exception.Message)"
    }
  }
  Set-PidFile $keep.pid
  Write-Boot ("发现 $($running.Count) 个哨兵实例，保留最早的 pid $($keep.pid)，已结束：" + ($killed -join ', '))
  exit 0
}

if ($running.Count -eq 1) {
  Set-PidFile $running[0].pid
  Write-Boot "哨兵已在运行（pid $($running[0].pid)），跳过"
  exit 0
}

# ---- 没在跑：找 node 并拉起 ----
$node = Find-ZstdNode
if (-not $node) { Write-Boot '找不到可用的 Node（需要 22.15+ / 24+，且支持 zstd）'; exit 2 }

try {
  $p = Start-Process -FilePath $Runner -ArgumentList @($node, $Sentinel, $OutLog) -WindowStyle Hidden -PassThru
  Start-Sleep -Milliseconds 2500
  $after = @(Get-SentinelProcesses)
  if ($after.Count -ge 1) {
    Set-PidFile $after[0].pid
    Write-Boot "已拉起哨兵并确认在跑（node $node，pid $($after[0].pid)，启动器 pid $($p.Id)）"
    exit 0
  }
  Write-Boot "拉起之后没检测到哨兵进程，请看 $OutLog"
  exit 4
} catch {
  Write-Boot "拉起失败：$($_.Exception.Message)"
  exit 3
}