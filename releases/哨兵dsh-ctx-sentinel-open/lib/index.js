/**
 * dsh-ctx-sentinel — DSH 服务端插件（Windows 版）
 *
 * 移动端（安卓）版本的电脑等价物：DSH 每次启动时检查「上下文哨兵」是否在跑，
 * 不在就静默拉起一个脱离 DSH 的后台进程（DSH 关掉、电脑重启都不影响它继续盯）。
 *
 * 哨兵本体：<本插件>/sentinel/ctx-sentinel.js
 *   - 读 %USERPROFILE%\.dsh\sentinel-target.json 决定盯哪个会话
 *   - 盯 %USERPROFILE%\.dsh\storages\session_projcache\sessions\<会话id>.json 的 contextPressure
 *   - 到 98%（可配）在投递目录写一份归档，并弹 Windows 通知
 *
 * 关键点：DSH 桌面版是 Electron，process.execPath 是 "DeepSeek Harness.exe"，
 * 不能拿它当 node 用（那会再开一个 Electron）。所以这里会自己找一个真正支持
 * zstd 的 node.exe（DSH 自带运行时优先），找不到就不拉，避免开出奇怪的东西。
 *
 * 幂等：已经在跑（pidfile 里的进程活着 + 心跳新鲜）就不重复拉；
 * 另外带一个看门狗，DSH 开着的时候定期确认哨兵还活着。
 */

import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const inject = []
export const name = 'dsh-ctx-sentinel'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = path.dirname(SCRIPT_DIR)

const DSH_HOME =
  process.env.DSH_HOME && process.env.DSH_HOME.trim()
    ? path.resolve(process.env.DSH_HOME)
    : path.join(os.homedir(), '.dsh')

const SENTINEL =
  process.env.DSH_CTX_SENTINEL && process.env.DSH_CTX_SENTINEL.trim()
    ? path.resolve(process.env.DSH_CTX_SENTINEL)
    : path.join(PKG_ROOT, 'sentinel', 'ctx-sentinel.js')

const PID_FILE = path.join(DSH_HOME, 'ctx-sentinel.pid')
const HEARTBEAT_FILE = path.join(DSH_HOME, 'ctx-sentinel.heartbeat')
const LOG_FILE = path.join(DSH_HOME, 'logs', 'ctx-sentinel.log')
const STALE_MS = 10 * 60_000

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

function readJsonSafe(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function logLine(text) {
  try {
    mkdirSync(path.dirname(LOG_FILE), { recursive: true })
    appendFileSync(LOG_FILE, `${new Date().toISOString()} [plugin] ${text}\n`, 'utf8')
  } catch {
    /* ignore */
  }
}

// ------------------------------------------------------------ 找 node

let cachedNode

/** 这个 exe 是真 node 且支持 zstd 吗（哨兵读会话日志要用） */
function zstdOk(exe) {
  try {
    const r = spawnSync(exe, ['-e', "process.exit(require('zlib').zstdDecompressSync?0:1)"], {
      stdio: 'ignore',
      windowsHide: true,
      timeout: 20_000,
    })
    return r.status === 0
  } catch {
    return false
  }
}

/**
 * 找一个可用的 node.exe。优先级：
 *   环境变量 DSH_CTX_SENTINEL_NODE -> %USERPROFILE%\.dsh\sentinel-node.txt（安装时写入）
 *   -> DSH 自带运行时 -> 常见安装位置 -> （非 Electron 时）process.execPath
 */
export function findNode() {
  if (cachedNode) return cachedNode
  const list = []
  const push = (p) => {
    const v = typeof p === 'string' ? p.trim() : ''
    if (v && !list.includes(v)) list.push(v)
  }

  push(process.env.DSH_CTX_SENTINEL_NODE)
  try {
    for (const line of readFileSync(path.join(DSH_HOME, 'sentinel-node.txt'), 'utf8').split(/\r?\n/)) push(line)
  } catch {
    /* 没有这份记录就算了 */
  }
  try {
    const rt = path.join(DSH_HOME, 'dsh-runtimes')
    for (const ent of readdirSync(rt, { withFileTypes: true })) {
    }
  } catch {
    /* ignore */
  }
  push(path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'nodejs', 'node.exe'))
  push(path.join(process.env['ProgramFiles(x86)'] ?? '', 'nodejs', 'node.exe'))
  push('D:\\nodejs\\node.exe')
  if (!/electron/i.test(process.execPath) && !/DeepSeek Harness/i.test(process.execPath)) push(process.execPath)

  for (const exe of list) {
    if (existsSync(exe) && zstdOk(exe)) {
      cachedNode = exe
      return exe
    }
  }
  return null
}

// ------------------------------------------------------------ 进程状态

/**
 * 扫出所有在跑的哨兵进程（node.exe 且命令行含 ctx-sentinel.js），按启动时间升序。
 *
 * 为什么不只信 pidfile：pidfile 只能记住一个 pid。历史上留过别的 pidfile、
 * 或者手动起过一次，就会有多个哨兵同时跑，它们轮流写同一份状态文件，
 * 于是「改了配置、杀了进程，状态却被另一个旧代码实例打回去」——实测踩过。
 * 所以判断「在不在跑」以进程表为准，pidfile 只是个加速缓存。
 *
 * 拿不到进程表（权限/系统限制）时返回空数组，调用方会退回 pidfile 逻辑。
 */
function scanSentinelProcs() {
  try {
    const script = [
      "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\"",
      "| Where-Object { $_.CommandLine -like '*ctx-sentinel.js*' }",
      "| Sort-Object CreationDate",
      "| ForEach-Object { [string]$_.ProcessId }",
    ].join(' ')
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 20_000,
    })
    if (r.status !== 0 || !r.stdout) return []
    return String(r.stdout)
      .split(/\r?\n/)
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isInteger(n) && n > 0)
      .filter((n) => pidAlive(n))
  } catch {
    return []
  }
}

/** 哨兵此刻在跑吗？（进程表里有 + 心跳不超过 10 分钟） */
export function sentinelStatus() {
  const info = readJsonSafe(PID_FILE)
  let pid = Number(info?.pid)

  // pidfile 里那个不活（或者根本没有）时，别急着判定「没在跑」——先扫一遍进程表
  if (!pidAlive(pid)) {
    const pids = scanSentinelProcs()
    if (!pids.length) {
      return { running: false, pid: Number.isInteger(pid) ? pid : null, reason: 'no-process' }
    }
    pid = pids[0]
  }

  let age = Infinity
  try {
    age = Date.now() - statSync(HEARTBEAT_FILE).mtimeMs
  } catch {
    age = Infinity
  }
  if (age > STALE_MS) return { running: false, pid, reason: 'stale-heartbeat', ageMs: age }
  const beat = readJsonSafe(HEARTBEAT_FILE)
  return { running: true, pid, ageMs: age, beat }
}

/**
 * 只留一个哨兵：扫到多个就把其余的结束掉（保留启动最早的那个）。
 * 返回 { kept, killed[] }；只有一个或没有时 killed 为空。
 */
export function dedupeSentinels() {
  const pids = scanSentinelProcs()
  if (pids.length <= 1) return { kept: pids[0] ?? null, killed: [] }
  const kept = pids[0]
  const killed = []
  for (const p of pids.slice(1)) {
    if (p === kept) continue
    try {
      process.kill(p)
      killed.push(p)
    } catch {
      /* 结束不了就算了，别让一次失败拖垮整个启动流程 */
    }
  }
  if (killed.length) logLine(`发现 ${pids.length} 个哨兵实例，保留 pid ${kept}，已结束：${killed.join(', ')}`)
  return { kept, killed }
}

/** 拉起哨兵（已经在本进程之外跑着就什么都不做）。返回 { started, reason, pid, node } */
export function startSentinel() {
  if (!existsSync(SENTINEL)) return { started: false, reason: `哨兵脚本不存在：${SENTINEL}` }

  // 先清理重复实例，再判断要不要拉起——否则「有多个但 pidfile 那个是死的」会再起一个
  const dedupe = dedupeSentinels()

  const status = sentinelStatus()
  if (status.running) return { started: false, reason: 'already-running', pid: status.pid, killed: dedupe.killed }

  const node = findNode()
  if (!node) return { started: false, reason: '找不到可用的 node（需要 Node 22.15+/24+，且支持 zstd）' }

  try {
    const child = spawn(node, [SENTINEL], {
      detached: true,
      windowsHide: true,
      stdio: 'ignore', // 哨兵自己写日志；这里不占句柄，免得锁住日志文件
      cwd: path.dirname(SENTINEL),
      env: process.env,
    })
    child.unref()
    return {
      started: true,
      pid: child.pid,
      node,
      reason: status.reason === 'stale-heartbeat' ? 'replaced-stale' : 'launched',
      killed: dedupe.killed,
    }
  } catch (error) {
    return { started: false, reason: `拉起失败：${error?.message ?? error}` }
  }
}

// ------------------------------------------------------------ 看门狗

let watchdog = null

/**
 * DSH 还开着的时候，每隔一段时间看一眼哨兵是否还活着（崩了就补拉）。
 * 定时器 unref，不会拖住 DSH 退出；watchdogMs=0 可关掉。
 */
function startWatchdog(config) {
  if (watchdog) return
  const raw = config?.watchdogMs ?? process.env.DSH_CTX_SENTINEL_WATCHDOG_MS ?? 5 * 60_000
  const ms = Number(raw)
  if (!Number.isFinite(ms) || ms <= 0) return
  try {
    watchdog = setInterval(() => {
      try {
        startSentinel()
      } catch {
        /* ignore */
      }
    }, Math.max(30_000, ms))
    watchdog.unref?.()
  } catch {
    watchdog = null
  }
}

/** DSH 启动时被调用。 */
export function apply(ctx, config) {
  void ctx
  const result = startSentinel()
  if (result.started) logLine(`DSH 启动，拉起哨兵（pid ${result.pid}，node ${result.node}）`)
  else if (result.reason !== 'already-running') logLine(`未拉起哨兵：${result.reason}`)
  startWatchdog(config)
  return result
}

export const start = startSentinel
export const status = sentinelStatus