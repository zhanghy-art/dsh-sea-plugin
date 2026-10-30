#!/usr/bin/env node
/**
 * 上下文哨兵 · Windows 版（dsh-ctx-sentinel）
 *
 * 移动端（安卓）版本的电脑等价物，功能一致：
 *   盯着目标会话的上下文用量，到阈值（默认 98%）就把整段会话导出成
 *   「会话转写.md」，投递到投递目录（默认 配置里的 deliverDir），
 *   并弹一条 Windows 通知。
 *
 * 与移动端的差异只在「怎么知道用量」：安卓上靠 DSH 的对外接口，电脑上直接读
 * DSH 的会话投影缓存 %USERPROFILE%\.dsh\storages\session_projcache\sessions\<会话id>.json
 * 里的 contextPressure（和 DSH 界面上的进度条同源同算法，见 pressureFromRows），
 * 既不打扰正在跑的 DSH，也不需要 DSH 处于打开状态。
 *
 * 用法：
 *   node ctx-sentinel.js                 # 常驻监视（默认）
 *   node ctx-sentinel.js --status        # 打印一次状态就退出
 *   node ctx-sentinel.js --once          # 只检查一次（达到阈值仍会导出）
 *   node ctx-sentinel.js --export-now    # 立刻导出一次（不看阈值）
 *   node ctx-sentinel.js --session=<id>  # 临时指定目标会话
 *   node ctx-sentinel.js --threshold=0.5 # 临时改阈值
 *   node ctx-sentinel.js --verbose       # 每次轮询都写日志
 *
 * 配置文件：%USERPROFILE%\.dsh\sentinel-target.json（不存在时用内置默认值，
 * 安装脚本会写一份默认配置）。键名容错：sessionId/id/target/session、
 * threshold/at、pollMs/interval/poll、deliverDir/dir/out、fileName/file/name 等。
 */

import { spawn } from 'node:child_process'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { decodeSessionLog, parseEvents, renderTranscript } from './lib/session-format.js'
import { extractChat, renderChatMarkdown, renderChatDelta, dayKey } from './lib/qq-chat.js'
import { discoverVaultPath, syncVaultIndex, writeChatNote } from './lib/vault-sync.js'
import { updateLiveStatePack, snapshotStatePack } from './lib/snapshot-state.js'

export const VERSION = '1.0.0'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = path.dirname(SCRIPT_DIR)

// ---------------------------------------------------------------- 路径

const HOME = os.homedir()
const DSH_HOME = process.env.DSH_HOME && process.env.DSH_HOME.trim()
  ? path.resolve(process.env.DSH_HOME)
  : path.join(HOME, '.dsh')

const PATHS = {
  dshHome: DSH_HOME,
  config: path.join(DSH_HOME, 'sentinel-target.json'),
  log: path.join(DSH_HOME, 'logs', 'ctx-sentinel.log'),
  state: path.join(DSH_HOME, 'sentinel-state.json'),
  pid: path.join(DSH_HOME, 'ctx-sentinel.pid'),
  heartbeat: path.join(DSH_HOME, 'ctx-sentinel.heartbeat'),
  sessions: path.join(DSH_HOME, 'sessions'),
  projcache: path.join(DSH_HOME, 'storages', 'session_projcache', 'sessions'),
  workspaceJson: path.join(DSH_HOME, 'storages', 'workspace.json'),
  toastPs1: path.join(PKG_ROOT, 'bin', 'toast.ps1'),
}

// ---------------------------------------------------------------- 默认配置

export const DEFAULT_CONFIG = {
  sessionId: 'auto', // 'auto' = 盯当前最活跃的会话；也可写死 'session-xxxx'
  threshold: 0.98, // 0.98 或 98 都认
  pollMs: 15_000, // 轮询间隔（毫秒）
  deliverDir: path.join(HOME, 'Documents', 'dsh-archive'), // 投递目录默认值，可在配置里覆盖
  fileName: '会话转写.md',
  keepHistory: true, // 覆盖前把上一份存进 历史/
  notify: true, // 弹 Windows 通知
  scanAll: true, // auto 模式：把所有会话都盯一遍，谁先冲过阈值都导出（false = 只盯最近发话的那个）
  reExportDelta: 0.01, // 已导出后，再用量涨了这么多才再导一次
  minReExportMs: 30 * 60_000, // 两次导出之间至少隔这么久
  nearWarn: [0.9, 0.95], // 接近阈值时的提醒点
  contextWindow: null, // 覆盖上下文窗口（一般不用填）
  // 分组投递：命中规则的会话不写 会话转写.md，而是落到自己的子目录里（每条都留档，永不覆盖）
  groups: [
    {
      name: 'QQ聊天', // 分组名（也用作默认子目录名）
      // 命中任一关键词即归入本组：workspace = 会话工作区目录名，cwd = 会话真实工作目录，title = 会话标题
      match: { workspace: ['qq-bridge'], cwd: ['qq-bridge', 'qq-chat'], title: ['QQ聊天', 'QQ群', 'qq-chat'] },
      dir: 'QQ聊天', // 相对 deliverDir 的子目录（也可写绝对路径）
      fileName: 'QQ聊天-{title}-{stamp}.md', // 支持 {title} {stamp} {date} {id} {session}
      keepEvery: true, // true = 每次导出都是一个新文件，永不覆盖（保证随时能翻）
      index: true, // 维护目录里的 索引.md
      enabled: true,
      // chatOnly=true：只导出双方在 QQ 上的对话，丢掉工具调用/思考/桥接提示词
      chatOnly: true,
      // 同步进长期记忆仓库（配置项 memoryDir），之后可在长期记忆里直接查
      toMemory: true,
      // 随身状态包：边走边写 persona/longmem/日记/未寄的信 的原始状态，90% 兜底时定格
      statePack: true,
    },
  ],
  // 转写参数（透传给 renderTranscript）
  includeReasoning: false,
  // 长期记忆仓库路径：留空则自动从 profile 的 cordis.patch.yml 里读 vaultPath
  memoryVault: '',
  maxReasoningChars: 1200,
  maxToolArgsChars: 1200,
  maxToolResultChars: 2000,
  maxTotalChars: 6_000_000,
  includeSystemNotices: true,
}

const LOG_MAX_BYTES = 2 * 1024 * 1024

// ---------------------------------------------------------------- 小工具

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function pad(n, w = 2) {
  return String(n).padStart(w, '0')
}

function stamp(ms = Date.now()) {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function fileStamp(ms = Date.now()) {
  const d = new Date(ms)
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

function fmtInt(n) {
  if (!Number.isFinite(n)) return String(n)
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

function ensureDir(dir) {
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    /* 已存在或权限问题，后面写入时会报 */
  }
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- 日志

let LOG_VERBOSE = false
const logBuffer = []

function rotateLog() {
  try {
    if (existsSync(PATHS.log) && statSync(PATHS.log).size > LOG_MAX_BYTES) {
      renameSync(PATHS.log, `${PATHS.log}.1`)
    }
  } catch {
    /* 轮转失败无所谓 */
  }
}

function log(level, message) {
  const line = `${stamp()} [${level}] ${message}`
  if (level === 'debug' && !LOG_VERBOSE) {
    logBuffer.push(line)
    if (logBuffer.length > 40) logBuffer.shift()
    return
  }
  if (level === 'debug') logBuffer.length = 0
  try {
    ensureDir(path.dirname(PATHS.log))
    appendFileSync(PATHS.log, line + '\n', 'utf8')
  } catch {
    /* 日志写不进去也不能让哨兵死掉 */
  }
  if (level === 'error' || level === 'warn') process.stderr.write(line + '\n')
}

function dumpBufferedLog() {
  if (!logBuffer.length) return
  const pending = logBuffer.join('\n')
  logBuffer.length = 0
  try {
    appendFileSync(PATHS.log, pending + '\n', 'utf8')
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------- 配置

function num(value, fallback) {
  const n = typeof value === 'string' ? Number(value) : value
  return Number.isFinite(n) ? n : fallback
}

function normalizeConfig(raw = {}) {
  const cfg = { ...DEFAULT_CONFIG }
  if (!raw || typeof raw !== 'object') return cfg

  const pick = (...keys) => {
    for (const k of keys) {
      if (raw[k] !== undefined && raw[k] !== null && raw[k] !== '') return raw[k]
    }
    return undefined
  }

  const id = pick('sessionId', 'id', 'target', 'session', 'watch', '会话')
  if (typeof id === 'string') cfg.sessionId = id.trim() || 'auto'

  let threshold = pick('threshold', 'at', 'ratio', '阈值')
  if (threshold !== undefined) {
    let t = num(threshold, cfg.threshold)
    if (t > 1) t = t / 100 // 98 → 0.98
    if (t > 0 && t <= 1) cfg.threshold = t
  }

  const poll = pick('pollMs', 'poll', 'intervalMs', 'interval', 'intervalSeconds')
  if (poll !== undefined) {
    let p = num(poll, cfg.pollMs)
    if (raw.intervalSeconds !== undefined || (p > 0 && p < 1000 && raw.pollMs === undefined && raw.poll === undefined)) p *= 1000
    if (p >= 1000) cfg.pollMs = p
  }

  const dir = pick('deliverDir', 'dir', 'out', 'output', 'deliverTo', '投递目录')
  if (typeof dir === 'string' && dir.trim()) {
    cfg.deliverDir = path.resolve(dir.replace(/^~(?=[\\/]|$)/, HOME))
  }

  const file = pick('fileName', 'file', 'name', '文件名')
  if (typeof file === 'string' && file.trim()) cfg.fileName = file.trim()

  const vault = pick('memoryVault', 'vault', 'vaultPath', '记忆仓库')
  if (typeof vault === 'string' && vault.trim()) {
    cfg.memoryVault = path.resolve(vault.trim().replace(/^~(?=[\\/]|$)/, HOME))
  }

  const bool = (v, fallback) => (typeof v === 'boolean' ? v : fallback)
  cfg.keepHistory = bool(pick('keepHistory', 'history'), cfg.keepHistory)
  cfg.notify = bool(pick('notify', 'notification', '通知'), cfg.notify)
  cfg.scanAll = bool(pick('scanAll', 'allSessions', 'scanAllSessions'), cfg.scanAll)
  cfg.includeReasoning = bool(pick('includeReasoning', 'reasoning', '包含思考'), cfg.includeReasoning)
  cfg.includeSystemNotices = bool(pick('includeSystemNotices', 'systemNotices'), cfg.includeSystemNotices)

  for (const key of [
    'maxReasoningChars',
    'maxToolArgsChars',
    'maxToolResultChars',
    'maxTotalChars',
    'reExportDelta',
    'minReExportMs',
    'contextWindow',
  ]) {
    const v = pick(key)
    if (v !== undefined) {
      const n = num(v, cfg[key])
      if (n !== null && n >= 0) cfg[key] = n
    }
  }

  if (Array.isArray(raw.nearWarn)) {
    cfg.nearWarn = raw.nearWarn.map((x) => num(x, 0)).filter((x) => x > 0 && x <= 1).sort((a, b) => a - b)
  }

  // 分组投递（groups）：配置里给了就整体替换内置分组；给空数组 = 关掉分组，全部走 会话转写.md
  if (Array.isArray(raw.groups)) {
    cfg.groups = raw.groups
      .map((g) => normalizeGroup(g))
      .filter((g) => g && g.enabled !== false)
  }

  return cfg
}

/** 归一化一个分组：补默认值、把 match 里的字符串变成数组。 */
function normalizeGroup(g) {
  if (!g || typeof g !== 'object') return null
  const name = String(g.name ?? g.group ?? '').trim()
  if (!name) return null
  const toList = (v) => (v == null ? [] : Array.isArray(v) ? v.map(String) : [String(v)]).filter((s) => s.trim())
  const match = g.match ?? {}
  return {
    name,
    match: {
      workspace: toList(match.workspace ?? match.workspaceDir ?? match.工作区),
      cwd: toList(match.cwd ?? match.workingDirectory ?? match.工作目录),
      title: toList(match.title ?? match.标题),
      sessionId: toList(match.sessionId ?? match.session ?? match.id),
    },
    dir: String(g.dir ?? g.deliverDir ?? name).trim() || name,
    // 分组自己的阈值（不填 = 跟全局一样）；98 / 0.98 都认
    threshold: (() => {
      const t = num(g.threshold, null)
      if (t === null) return null
      const v = t > 1 ? t / 100 : t
      return v > 0 && v <= 1 ? v : null
    })(),
    fileName: String(g.fileName ?? `${name}-{title}-{stamp}.md`).trim(),
    keepEvery: g.keepEvery !== false, // 默认永不覆盖
    index: g.index !== false, // 默认维护索引
    enableScanAll: g.enableScanAll === true, // 默认扫描范围不受分组影响
    enabled: g.enabled !== false,
    // chatOnly：只导出双方对话（QQ 专用）；toMemory：同步进长期记忆仓库
    chatOnly: g.chatOnly === true,
    toMemory: g.toMemory === true,
    // statePack：随身状态包（边走边写原始状态，90% 兜底定格）
    statePack: g.statePack === true,
  }
}

function loadConfig(cli) {
  let cfg = { ...DEFAULT_CONFIG }
  const configPath = cli.values.config ? path.resolve(cli.values.config) : PATHS.config
  cfg.configPath = configPath
  if (existsSync(configPath)) {
    const raw = readJson(configPath)
    if (raw) {
      cfg = { ...normalizeConfig(raw), configPath }
    } else {
      log('warn', `配置文件无法解析，改用内置默认值：${configPath}`)
    }
  }
  // 命令行覆盖
  if (cli.values.session) cfg.sessionId = cli.values.session
  if (cli.values.threshold !== undefined) {
    let t = num(cli.values.threshold, cfg.threshold)
    if (t > 1) t = t / 100
    if (t > 0 && t <= 1) cfg.threshold = t
  }
  if (cli.values.poll !== undefined) {
    const p = num(cli.values.poll, cfg.pollMs)
    if (p >= 1000) cfg.pollMs = p
  }
  if (cli.values.deliver !== undefined) cfg.deliverDir = path.resolve(cli.values.deliver)
  if (cli.values.file !== undefined) cfg.fileName = cli.values.file
  if (cli.flags.has('no-notify')) cfg.notify = false
  return cfg
}

// ---------------------------------------------------------------- 会话发现

const SESSION_ID_RE = /^session-[0-9a-fA-F-]{8,64}$/

/** 会话日志目录：<DSH_HOME>/sessions/<转义过的工作区名>/<会话id>/session.v4.jsonl.zstd */
function findSessionStore(sessionId) {
  if (!SESSION_ID_RE.test(sessionId)) return null
  for (const root of listDirs(PATHS.sessions)) {
    const dir = path.join(PATHS.sessions, root, sessionId)
    const logFile = path.join(dir, 'session.v4.jsonl.zstd')
    if (existsSync(logFile)) return { id: sessionId, dir, log: logFile, workspaceDir: root }
  }
  return null
}

function listDirs(root) {
  const out = []
  for (const name of safeReaddir(root)) {
    try {
      if (statSync(path.join(root, name)).isDirectory()) out.push(name)
    } catch {
      /* 读不到的条目直接跳过 */
    }
  }
  return out
}

function safeReaddir(dir) {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/** 投影缓存（contextPressure 的所在地）。 */
function projcacheFile(sessionId) {
  return path.join(PATHS.projcache, `${sessionId}.json`)
}

/** 读投影缓存里的 rows（DSH 正在重写这个文件时会读到半截，重试 3 次）。 */
function readProjRows(sessionId) {
  const file = projcacheFile(sessionId)
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parsed = readJson(file)
    const rows = parsed?.record?.rows
    if (rows && typeof rows === 'object') return { rows, identity: parsed.record?.identity ?? null }
    try {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60)
    } catch {
      /* 环境不支持就立即重试 */
    }
  }
  return null
}

/** auto 模式：把所有「有投影缓存 + 有日志 + 你发过话」的会话收集起来。 */
function collectCandidates(cfg, onlyId) {
  const ids = onlyId
    ? [onlyId]
    : safeReaddir(PATHS.projcache)
        .filter((n) => n.endsWith('.json'))
        .map((n) => n.slice(0, -5))
  const out = []
  for (const id of ids) {
    if (!SESSION_ID_RE.test(id)) continue
    const store = findSessionStore(id)
    if (!store) continue
    const cache = readProjRows(id)
    if (!cache) continue
    const pressure = pressureFromRows(cache.rows, cache.identity, cfg)
    if (!pressure) continue
    if (!onlyId && (pressure.blank || !pressure.lastPromptAt)) continue // 空白会话/还没发过话的会话不算
    let projMtime = 0
    try {
      projMtime = statSync(projcacheFile(id)).mtimeMs
    } catch {
      /* ignore */
    }
    out.push({ ...store, pressure, projMtime, recentAt: num(pressure.lastPromptAt, projMtime) })
  }
  return out
}

/**
 * 挑目标：
 *   - 配置里写死了会话 → 就盯它（faithful 移动端的「指定一个会话」用法）；
 *   - auto → 盯「你最近发过话」的那个会话（sessionListMetadata.lastPromptAt），
 *     同时把其它候选一起带着，谁先冲过阈值都能被导出。
 */
function resolveTargets(cfg) {
  if (cfg.sessionId && cfg.sessionId !== 'auto') {
    const list = collectCandidates(cfg, cfg.sessionId)
    if (!list.length) return { error: `找不到会话 ${cfg.sessionId}（没有日志目录或还没有上下文读数）` }
    return { pinned: true, target: list[0], candidates: list }
  }
  const list = collectCandidates(cfg, null)
  if (!list.length) return { error: '还没找到任何可盯的会话（DSH 还没产生带上下文读数的会话）' }
  list.sort((a, b) => b.recentAt - a.recentAt)
  return { pinned: false, target: list[0], candidates: list }
}

// ---------------------------------------------------------------- 用量读数

/**
 * 用量读数（与 DSH 界面同源同算法）。
 *
 * 投影缓存里的 contextPressure 存的是：
 *   pressureTokens        最近一次请求真实发出去的 prompt 大小（provider 回报，不含回复）
 *   surfaceTokens         这条会话「表面」（日志里可见消息）的估算总量
 *   sampledSurfaceTokens  取那次 provider 读数时 surfaceTokens 的快照
 *   contextWindow         这条路由的上下文窗口（1M）
 * DSH 界面上的百分比不是 surface/窗口，而是
 *   projectedTokens = pressureTokens + (surfaceTokens - sampledSurfaceTokens)
 * —— 以 provider 回报为锚，再补上采样之后的增长；这样压缩/裁剪一发生，数字立刻跟下来。
 * 哨兵用同一个数，保证「到 98% 导出」和你在界面上看到的那根条一致。
 */
function pressureFromRows(rows, identity, cfg) {
  const pressure = rows?.contextPressure?.val ?? null
  if (!pressure) return null

  const contextWindow = num(cfg.contextWindow, 0) || num(pressure.contextWindow, 0) || 1_000_000
  const surfaceTokens = num(pressure.surfaceTokens, 0)
  const sampled = num(pressure.sampledSurfaceTokens, surfaceTokens)
  const reported = num(pressure.pressureTokens, 0)

  let usedTokens = 0
  let source = null
  if (reported > 0) {
    usedTokens = Math.max(0, reported + surfaceTokens - sampled)
    source = 'projectedTokens'
  } else if (surfaceTokens > 0) {
    usedTokens = surfaceTokens
    source = 'surfaceTokens'
  } else {
    return null
  }

  const meta = rows.sessionListMetadata?.val ?? null
  const selection = rows.modelSelection?.val?.lastUsed ?? null
  return {
    usedTokens,
    contextWindow,
    ratio: contextWindow > 0 ? usedTokens / contextWindow : 0,
    source,
    surfaceTokens,
    reportedTokens: reported > 0 ? reported : null,
    sampledSurfaceTokens: sampled,
    title: rows.title?.val ?? null,
    cwd: rows.workingDirectory?.val ?? identity?.cwd ?? null,
    lastPromptAt: num(meta?.lastPromptAt, null),
    blank: meta?.blank === true,
    model: selection
      ? `${selection.provider ?? '?'} / ${selection.model ?? '?'}${selection.reasoningEffort ? `（reasoning: ${selection.reasoningEffort}）` : ''}`
      : null,
    tokens: rows.tokenUsage?.val?.totals ?? null,
    stats: rows.sessionStats?.val ?? null,
  }
}

function pct(ratio) {
  return `${(100 * (ratio ?? 0)).toFixed(1)}%`
}

function usageText(pressure) {
  if (!pressure) return '暂无读数'
  return `${pct(pressure.ratio)}（${fmtInt(pressure.usedTokens)}/${fmtInt(pressure.contextWindow)} tokens，${pressure.source}）`
}

// ---------------------------------------------------------------- 状态文件

function loadState() {
  const raw = readJson(PATHS.state)
  if (raw && typeof raw === 'object' && raw.sessions) return raw
  return { version: 1, sessions: {} }
}

function saveState(state) {
  try {
    writeFileSync(PATHS.state, JSON.stringify(state, null, 2), 'utf8')
  } catch (error) {
    log('warn', `状态文件写入失败：${error?.message ?? error}`)
  }
}

// ---------------------------------------------------------------- 单实例

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

function heartbeatAgeMs() {
  try {
    return Date.now() - statSync(PATHS.heartbeat).mtimeMs
  } catch {
    return Infinity
  }
}

/** 另一个哨兵正在跑吗？（pid 活着 + 心跳新鲜） */
export function sentinelRunning() {
  const info = readJson(PATHS.pid)
  const pid = num(info?.pid, 0)
  if (!pidAlive(pid)) return { running: false, pid: null }
  if (pid === process.pid) return { running: false, pid: null }
  if (heartbeatAgeMs() > 10 * 60_000) return { running: false, pid, stale: true }
  return { running: true, pid, info }
}

function claimSingleInstance() {
  const status = sentinelRunning()
  if (status.running) {
    log('info', `已有哨兵在跑（pid ${status.pid}），本进程退出。`)
    return false
  }
  if (status.stale) log('warn', `发现陈旧 pidfile（pid ${status.pid} 已无心跳），接管。`)
  ensureDir(DSH_HOME)
  try {
    writeFileSync(PATHS.pid, JSON.stringify({ pid: process.pid, startedAt: Date.now(), version: VERSION, script: fileURLToPath(import.meta.url) }, null, 2), 'utf8')
  } catch (error) {
    log('warn', `pidfile 写入失败：${error?.message ?? error}`)
  }
  return true
}

function writeHeartbeat(target, pressure, cfg) {
  try {
    writeFileSync(
      PATHS.heartbeat,
      JSON.stringify(
        {
          pid: process.pid,
          time: Date.now(),
          sessionId: target?.id ?? null,
          title: pressure?.title ?? null,
          ratio: pressure?.ratio ?? null,
          usedTokens: pressure?.usedTokens ?? null,
          usageSource: pressure?.source ?? null,
          surfaceTokens: pressure?.surfaceTokens ?? null,
          contextWindow: pressure?.contextWindow ?? null,
          threshold: cfg.threshold,
          deliverDir: cfg.deliverDir,
        },
        null,
        2,
      ),
      'utf8',
    )
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------- 导出

function buildMeta(target, pressure, cfg, reason) {
  return {
    title: pressure?.title ?? null,
    sessionId: target.id,
    cwd: pressure?.cwd ?? null,
    logPath: target.log,
    exportedAt: Date.now(),
    reason,
    threshold: cfg.threshold,
    ratio: pressure?.ratio ?? null,
    usedTokens: pressure?.usedTokens ?? null,
    usageSource: pressure?.source ?? null,
    surfaceTokens: pressure?.surfaceTokens ?? null,
    contextWindow: pressure?.contextWindow ?? null,
    model: pressure?.model ?? null,
    tokens: pressure?.tokens ?? null,
    stats: pressure?.stats ?? null,
    options: cfg,
  }
}

/** 判断一个会话属于哪个分组；不属于任何分组就返回 null（走 会话转写.md）。 */
function matchGroup(target, pressure, cfg) {
  for (const g of cfg.groups ?? []) {
    if (g.enabled === false) continue
    const m = g.match ?? {}
    const hay = {
      workspace: String(target?.workspaceDir ?? ''),
      cwd: String(pressure?.cwd ?? ''),
      title: String(pressure?.title ?? ''),
      sessionId: String(target?.id ?? ''),
    }
    for (const field of ['workspace', 'cwd', 'title', 'sessionId']) {
      for (const needle of m[field] ?? []) {
        if (!needle) continue
        if (hay[field].toLowerCase().includes(String(needle).toLowerCase())) return g
      }
    }
  }
  return null
}

/** 把分组的文件名模板里的占位符换成真值。 */
function groupFileName(g, target, pressure, ms = Date.now()) {
  const safe = (s) =>
    String(s ?? '')
      .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60) || '无标题'
  const d = new Date(ms)
  const map = {
    title: safe(pressure?.title),
    stamp: fileStamp(ms),
    date: `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`,
    time: `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`,
    id: target.id,
    session: target.id.replace(/^session-/, '').slice(0, 8),
    group: safe(g.name),
    pct: `${Math.round(100 * (pressure?.ratio ?? 0))}`,
  }
  let name = String(g.fileName || `${g.name}-{title}-{stamp}.md`)
  for (const [k, v] of Object.entries(map)) name = name.replace(new RegExp(`\\{${k}\\}`, 'g'), v)
  // 万一用户给的模板里没带 {stamp}，且 keepEvery，也要保证不重名
  if (g.keepEvery !== false && !/\{stamp\}|\{time\}|\{date\}/.test(String(g.fileName || ''))) {
    name = `${path.parse(name).name}-${map.stamp}${path.parse(name).ext || '.md'}`
  }
  return name.endsWith('.md') ? name : `${name}.md`
}

/** 万一同一秒导出两个同名会话，加 -2/-3 后缀，绝不覆盖已有文件。 */
function uniqueFile(file) {
  if (!existsSync(file)) return file
  const dir = path.dirname(file)
  const base = path.basename(file, '.md')
  for (let i = 2; i < 999; i += 1) {
    const candidate = path.join(dir, `${base}-${i}.md`)
    if (!existsSync(candidate)) return candidate
  }
  return path.join(dir, `${base}-${Date.now()}.md`)
}

/** 往分组目录的 索引.md 里追加一行（没有就先写表头）。 */
function appendGroupIndex(indexFile, groupName, entry) {
  const header = `# ${groupName} 导出索引\n\n> 上下文哨兵自动维护：每导出一份就在这里加一行，文件本身永不覆盖，随时可以翻。\n\n| 导出时间 | 会话标题 | 用量 | 会话 ID | 文件 |\n| --- | --- | --- | --- | --- |\n`
  try {
    if (!existsSync(indexFile)) {
      ensureDir(path.dirname(indexFile))
      writeFileSync(indexFile, header, 'utf8')
    }
    appendFileSync(indexFile, `| ${entry.at} | ${entry.title} | ${entry.pct} | \`${entry.id}\` | [${entry.file}](${encodeURIComponent(entry.file)}) |\n`, 'utf8')
  } catch (error) {
    log('warn', `写分组索引失败（${indexFile}）：${error?.message ?? error}`)
  }
}

/** 会话标题里不能出现在文件名里的字符，全部替换掉。 */
function safeName(s) {
  const cleaned = String(s ?? '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/[\r\n\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned.slice(0, 40) || '无标题'
}

/**
 * 一个会话（= 一次 QQ 对话）只对应一个聊天文件，名字不带时间戳：
 * 这样「边走边写」永远续写同一个文件，不会每次导出一份新的。
 */
/**
 * 会话短 id：取 session- 后面 8 位，作为「一个对话一个文件」的真正身份。
 * title 会变（会话被重命名、或者临时标题），绝不能拿它当文件身份。
 */
function sessionShortId(target) {
  return String(target?.id ?? '').replace(/^session-/, '').slice(0, 8)
}

/**
 * 找这个对话**已经存在**的聊天文件。
 *
 * 每个工作区对话只开一次文件，之后一路续写。
 * 原来的命名是 `QQ聊天-<title>-<sess8>.md`，title 一变就换了名字、于是又新开一份——
 * 实测 session-ab2bbc43 被拆成了「后台提醒与行为调整」和「第2次」两个文件。
 * 现在只要目录里已经有同一 sess8 的文件，就一律复用它，不再新建。
 * 万一历史上已经拆成好几份（像 ab2bbc43），挑行数最多的那份当主文件。
 */
function findExistingChatFile(groupDir, target, groupName = '会话') {
  const sess = sessionShortId(target)
  if (!sess) return null
  let names = []
  try {
    names = readdirSync(groupDir)
  } catch {
    return null
  }
  const prefix = safeName(groupName)
  const hits = names.filter((n) => n.startsWith(`${prefix}-`) && n.endsWith(`-${sess}.md`))
  if (!hits.length) return null
  if (hits.length === 1) return path.join(groupDir, hits[0])
  let best = hits[0]
  let bestLines = -1
  for (const n of hits) {
    try {
      const lines = readFileSync(path.join(groupDir, n), 'utf8').split('\n').length
      if (lines > bestLines) {
        bestLines = lines
        best = n
      }
    } catch {
      /* 读不动就跳过 */
    }
  }
  log('warn', `会话 ${target.id} 在归档目录里有 ${hits.length} 份聊天文件（${hits.join(' / ')}），按行数最多选用 ${best}，其余请人工归档`)
  return path.join(groupDir, best)
}

function chatFileName(group, target, pressure) {
  const sess = sessionShortId(target)
  const title = safeName(pressure?.title ?? target.pressure?.title)
  const prefix = safeName(group?.name || '会话')
  return `${prefix}-${title}-${sess}.md`
}

/** 该会话已被 90% 定格冻结了吗？冻结后不再续写、不再导出。 */
function isChatFrozen(target) {
  const st = loadState()
  return st.sessions?.[target.id]?.frozen === true
}

/** 90% 定格后置冻结标记：这个会话的对话/状态包到此为止。 */
function freezeSession(target) {
  const st = loadState()
  st.sessions = st.sessions ?? {}
  const row = st.sessions[target.id] ?? { exports: 0 }
  row.frozen = true
  row.frozenAt = Date.now()
  st.sessions[target.id] = row
  st.version = 1
  st.updatedAt = Date.now()
  saveState(st)
}

/**
 * 「只生成一次 + 后续续写」：同一个会话只保留一个聊天文件。
 * 首次写全量（含标题头），之后每次只在末尾追加新出现的对话行；
 * 水位记在 state 里（session id → {ids, lastTime, lastDay}），重启也不丢。
 */
async function updateChatFile({ group, target, pressure, cfg, reason = '续写' }) {
  const started = Date.now()
  const decoded = decodeSessionLog(target.log)
  const events = parseEvents(decoded.text)
  const botName = String(cfg?.statePack?.botName || 'AI')
  const chat = extractChat(events, { botName })
  const meta = buildMeta(target, pressure, cfg, reason)

  const groupDir = path.isAbsolute(group.dir) ? group.dir : path.join(cfg.deliverDir, group.dir)
  ensureDir(groupDir)
  // 先复用这个对话已经有的文件（title 变了也不新开），确实没有才按新名字建。
  const file = findExistingChatFile(groupDir, target, group?.name) ?? path.join(groupDir, chatFileName(group, target, pressure))

  const state = loadState()
  const row = state.sessions?.[target.id] ?? {}
  // 规矩：只要没有「真正换对话」的信号，就不真冻结——冻结会挡住续写。
  // frozen 从此只表示「这一份归档已经定型，别再重复生成第二份新文件」，
  // 绝不阻断「往同一个文件里续写新对话」——续写永远允许。
  const frozenForDump = row.frozen === true

  const fresh = !existsSync(file)
  if (frozenForDump && fresh) {
    // 只在「同一份归档本该已存在却不见了」时才会走到这里，留个痕方便追
    log('debug', `会话 ${target.id} 标记为已定型，但归档文件不存在，仍按首写处理`)
  }
  const wm = row.chat ?? { ids: [], lastTime: 0, lastDay: '' }
  const wmIds = new Set(wm.ids ?? [])

  // 增量：时间晚于水位，或者有 messageId 且没见过（同分钟内的消息靠 id 兜底）
  let toAppend = chat.lines
  if (!fresh) {
    toAppend = chat.lines.filter((l) => l.time > num(wm.lastTime, 0) || (l.messageId && !wmIds.has(l.messageId)))
  }

  if (fresh) {
    writeFileSync(file, renderChatMarkdown({ lines: chat.lines, meta, botName }), 'utf8')
  } else if (toAppend.length) {
    const delta = renderChatDelta(toAppend, wm.lastDay || '', { botName })
    appendFileSync(file, `${delta}\n`, 'utf8')
  } else {
    // 一条新对话都没有——什么都不写（这正是「不重新生成」的体现）
    return { chat, events, decoded, meta, markdown: null, file, frozen: false, appended: 0 }
  }

  // 刷新水位
  const ids = chat.lines.map((l) => l.messageId).filter(Boolean)
  const lastTime = chat.lines.length ? chat.lines[chat.lines.length - 1].time : num(wm.lastTime, 0)
  const lastDay = chat.lines.length ? dayKey(lastTime) : (wm.lastDay || '')
  state.sessions = state.sessions ?? {}
  state.sessions[target.id] = {
    ...row,
    chat: { ids, lastTime, lastDay },
    lastChatFile: path.basename(file),
    title: pressure?.title ?? row.title ?? null,
  }
  state.version = 1
  state.updatedAt = Date.now()
  saveState(state)

  const markdown = fresh
    ? renderChatMarkdown({ lines: chat.lines, meta, botName })
    : readFileSync(file, 'utf8')
  log(
    'debug',
    `聊天续写（${fresh ? '新建' : '追加'} ${toAppend.length} 条）${file}（会话 ${target.id}，共 ${chat.lines.length} 条，耗时 ${Date.now() - started}ms）`,
  )
  return { chat, events, decoded, meta, markdown, file, frozen: false, appended: toAppend.length }
}

async function exportTranscript(target, pressure, cfg, reason) {
  const started = Date.now()

  // 分组投递：命中的会话进自己的目录
  const group = matchGroup(target, pressure, cfg)
  if (group) {
    // chatOnly：只要双方在 QQ 上的对话，工具调用/思考/桥接提示词一律不写。
    // 「只生成一次 + 续写」：一个会话只维护一个文件，不重复生成。
    let markdown
    let chat = null
    let outFile
    let events
    let decoded
    let skipped = false

    if (group.chatOnly) {
      const res = await updateChatFile({ group, target, pressure, cfg, reason })
      chat = res.chat
      events = res.events
      decoded = res.decoded
      outFile = res.file
      // updateChatFile 现在永远返回 frozen:false（冻结不再阻断续写），
      // 这里保留一个兜底判断即可，正常不会进来。
      if (res.frozen) {
        log('debug', `会话 ${target.id} 归档已定型，本次不重复转储`)
        return { outFile, markdown: null, events, decoded, group: group.name, chat, memoryPath: null, frozen: true }
      }
      if (!chat.lines.length) {
        log('warn', `分组「${group.name}」开了 chatOnly 但一条对话都没剥出来，回退成完整转写（会话 ${target.id}）`)
        decoded = decodeSessionLog(target.log)
        events = parseEvents(decoded.text)
        chat = null
        const meta = buildMeta(target, pressure, cfg, reason)
        markdown = renderTranscript({ events, meta, options: cfg })
        const groupDir = path.isAbsolute(group.dir) ? group.dir : path.join(cfg.deliverDir, group.dir)
        ensureDir(groupDir)
        outFile = uniqueFile(path.join(groupDir, groupFileName(group, target, pressure)))
        writeFileSync(outFile, markdown, 'utf8')
      } else {
        markdown = res.markdown
        skipped = res.appended === 0 && !existsSync(res.file)
      }
    } else {
      decoded = decodeSessionLog(target.log)
      events = parseEvents(decoded.text)
      const meta = buildMeta(target, pressure, cfg, reason)
      markdown = renderTranscript({ events, meta, options: cfg })
      const groupDir = path.isAbsolute(group.dir) ? group.dir : path.join(cfg.deliverDir, group.dir)
      ensureDir(groupDir)
      outFile = uniqueFile(path.join(groupDir, groupFileName(group, target, pressure)))
      writeFileSync(outFile, markdown, 'utf8')
    }

    appendFileSync(
      path.join(path.dirname(outFile), '导出记录.log'),
      `${stamp()}  会话 ${target.id}  用量 ${pct(pressure?.ratio)}  ${fmtInt(pressure?.usedTokens ?? 0)}/${fmtInt(pressure?.contextWindow ?? 0)} tokens（${pressure?.source ?? '?'}）  事件 ${events.length}  帧 ${decoded.frames}  正文 ${fmtInt(markdown?.length ?? 0)} 字符  原因：${reason}${chat ? `  对话 ${chat.lines.length} 条（去重丢 ${chat.stats.dropped}）` : ''}  文件：${path.basename(outFile)}\n`,
      'utf8',
    )
    if (group.index !== false) {
      appendGroupIndex(path.join(path.dirname(outFile), '索引.md'), group.name, {
        at: stamp(),
        title: (pressure?.title ?? '无标题').replace(/\|/g, '\\|'),
        pct: pct(pressure?.ratio),
        id: target.id,
        file: path.basename(outFile),
      })
    }
    log(
      'info',
      `已导出（分组「${group.name}」${chat ? '·仅对话' : ''}）${outFile}（会话 ${target.id}，用量 ${pct(pressure?.ratio)}，事件 ${events.length}，${fmtInt(markdown?.length ?? 0)} 字符，耗时 ${Date.now() - started}ms${decoded.stopped ? `，日志尾部异常：${decoded.stopped}` : ''}）`,
    )

    // 状态包每个工作区对话只开一次、之后只续写。
    // 这里原先会在每次导出时调 snapshotStatePack 写一份「只有全量快照」的文件，
    // 和 updateLiveStatePack 维护的同一个文件互相覆盖（一个 writeFileSync 覆盖全文件、
    // 一个 append 增量），结果同一个对话被拆成两份。现在状态包统一由
    // updateLiveStatePack 在 tick 里维护（建档 + 增量 + 实时块），这里不再插手。

    // toMemory：同步进长期记忆仓库，之后能在长期记忆里直接查到这段聊天
    let memoryPath = null
    if (group.toMemory) {
      memoryPath = await writeChatToVault({ chat, events, meta: buildMeta(target, pressure, cfg, reason), markdown, target, cfg })
    }
    return { outFile, markdown, events, decoded, group: group.name, chat, memoryPath }
  }

  const decoded = decodeSessionLog(target.log)
  const events = parseEvents(decoded.text)
  const meta = buildMeta(target, pressure, cfg, reason)
  const markdown = renderTranscript({ events, meta, options: cfg })

  ensureDir(cfg.deliverDir)
  const outFile = path.join(cfg.deliverDir, cfg.fileName)
  if (cfg.keepHistory && existsSync(outFile)) {
    try {
      const historyDir = path.join(cfg.deliverDir, '历史')
      ensureDir(historyDir)
      const old = statSync(outFile).mtime
      renameSync(outFile, path.join(historyDir, `${path.parse(cfg.fileName).name}-${fileStamp(old)}.md`))
    } catch (error) {
      log('warn', `旧文件归档失败（继续覆盖）：${error?.message ?? error}`)
    }
  }
  writeFileSync(outFile, markdown, 'utf8')
  appendFileSync(
    path.join(cfg.deliverDir, '导出记录.log'),
    `${stamp()}  会话 ${target.id}  用量 ${pct(pressure?.ratio)}  ${fmtInt(pressure?.usedTokens ?? 0)}/${fmtInt(pressure?.contextWindow ?? 0)} tokens（${pressure?.source ?? '?'}）  事件 ${events.length}  帧 ${decoded.frames}  正文 ${fmtInt(markdown.length)} 字符  原因：${reason}\n`,
    'utf8',
  )

  log(
    'info',
    `已导出 ${outFile}（会话 ${target.id}，用量 ${pct(pressure?.ratio)}，事件 ${events.length}，${fmtInt(markdown.length)} 字符，耗时 ${Date.now() - started}ms${decoded.stopped ? `，日志尾部异常：${decoded.stopped}` : ''}）`,
  )
  return { outFile, markdown, events, decoded }
}

/**
 * 把这次导出的 QQ 聊天同步进长期记忆仓库，并让插件刷新索引。
 * 任何一步失败都只告警，不影响已经落盘的导出文件。
 */
async function writeChatToVault({ chat, meta, markdown, target, cfg }) {
  const vault = (cfg.memoryVault && cfg.memoryVault.trim()) || discoverVaultPath(PATHS.dshHome)
  if (!vault) {
    log('warn', '未找到长期记忆仓库路径（配置里没写 memoryVault，cordis.patch.yml 里也没有 vaultPath），跳过同步')
    return null
  }
  const lines = chat?.lines ?? []
  if (!lines.length && !markdown) return null

  try {
    const res = writeChatNote({ lines, meta, vault, stats: chat?.stats ?? {}, markdown, botName: String(cfg?.statePack?.botName || 'AI') })
    if (!res.ok) {
      log('warn', `同步长期记忆失败：${res.reason}`)
      return null
    }

    // 插件只在启动时同步一次索引，写完必须戳一下 HTTP 接口它才认
    const sync = await syncVaultIndex()
    if (sync.ok) {
      log(
        'info',
        `已同步长期记忆（${res.updated ? '更新' : '新建'}）：${res.file}${sync.added ? `，索引新增 ${sync.added}` : ''}${sync.updated ? `，索引更新 ${sync.updated}` : ''}`,
      )
    } else {
      log('warn', `长期记忆文件已写入 ${res.file}，但索引没刷新：${sync.reason}（下次 DSH 启动会自动补上）`)
    }
    return res.file
  } catch (error) {
    log('warn', `同步长期记忆异常：${error?.message ?? error}`)
    return null
  }
}

function notify(title, message) {
  if (!existsSync(PATHS.toastPs1)) {
    log('debug', '未找到 bin/toast.ps1，跳过通知')
    return
  }
  try {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', PATHS.toastPs1, '-Title', title, '-Message', message],
      { windowsHide: true, stdio: 'ignore', detached: false },
    )
    child.on('error', (error) => log('debug', `通知进程启动失败：${error?.message ?? error}`))
    child.unref?.()
  } catch (error) {
    log('debug', `通知失败：${error?.message ?? error}`)
  }
}

// ---------------------------------------------------------------- 主循环

function shouldExport(state, target, pressure, cfg, force, thresholdOverride) {
  const threshold = thresholdOverride ?? cfg.threshold
  if (force) return { yes: true, reason: '手动触发' }
  const row = state.sessions?.[target.id]
  if (!row || !row.lastExportAt) return { yes: true, reason: `用量达到阈值 ${(threshold * 100).toFixed(0)}%` }
  const delta = (pressure?.ratio ?? 0) - num(row.lastRatio, 0)
  const since = Date.now() - num(row.lastExportAt, 0)
  if (delta >= cfg.reExportDelta && since >= cfg.minReExportMs) {
    return { yes: true, reason: `用量继续增长到 ${(100 * (pressure?.ratio ?? 0)).toFixed(1)}%` }
  }
  return { yes: false }
}

function recordExport(state, target, pressure, cfg, outFile, reason) {
  state.sessions = state.sessions ?? {}
  const row = state.sessions[target.id] ?? { exports: 0 }
  row.lastExportAt = Date.now()
  row.lastRatio = pressure?.ratio ?? null
  row.lastRatioAtExport = pressure?.ratio ?? null // 这个只用于「上次导出时的用量」显示，不会被重新武装逻辑清零
  row.lastFile = outFile
  row.lastReason = reason
  row.title = pressure?.title ?? row.title ?? null
  row.exports = num(row.exports, 0) + 1
  state.sessions[target.id] = row
  state.version = 1
  state.updatedAt = Date.now()
  saveState(state)
}

async function tick(cfg, ctx, { force = false } = {}) {
  const resolved = resolveTargets(cfg)
  if (resolved.error) {
    log('warn', resolved.error)
    writeHeartbeat(null, null, cfg)
    return { ok: false, error: resolved.error }
  }
  const { target, candidates, pinned } = resolved

  if (ctx.lastTargetId !== target.id) {
    log(
      'info',
      `盯上会话 ${target.id}${pinned ? '（配置里写死）' : `（你最近发过话：${target.pressure.title ?? '无标题'}）`}：${target.log}`,
    )
    ctx.lastTargetId = target.id
  }

  const pressure = target.pressure
  writeHeartbeat(target, pressure, cfg)

  // 「边走边写」：当前正在聊的 QQ 会话，每次轮询都把新出现的对话续写进那唯一一个文件。
  // 2026-10-26 修复：这里原本带 `!isChatFrozen(target)`，导致会话一旦 90% 转储被冻结后，
  // 即便中途压缩、用量掉回 10%，新对话也永远不再写进归档（实测 7 小时一条都没进）。
  // 定格冻结的本意只是「别重复生成新文件 / 别重复转储」，不该把「续写同一个文件」也一起冻死。
  const activeGroup = matchGroup(target, pressure, cfg)
  if (activeGroup?.chatOnly === true && activeGroup.enabled !== false) {
    try {
      const res = await updateChatFile({ group: activeGroup, target, pressure, cfg, reason: '边走边写' })
      if (res.appended > 0) log('debug', `边走边写：${res.file} 追加 ${res.appended} 条对话（共 ${res.chat.lines.length} 条）`)
      // 记下这个对话已经归档多少条，状态包的「现在」区块要用
      ctx.lastChatLines = { id: target.id, lines: res.chat?.lines?.length ?? null }
    } catch (error) {
      log('warn', `边走边写失败（不影响监视）：${error?.message ?? error}`)
    }
  }

  // 随身状态包：只跟「当前这个 QQ 对话」绑定，边走边写续写它。
  // 2026-10-26 修复：去掉 `!isChatFrozen(target)`（原因同上——冻结不该连状态包一起停更，
  // 转储之后继续聊的时候，状态包要接着更新，不然留在盘上的是一份过期的状态）。
  // 「实时添加」：把当前对话的实时信息传进去，
  // 由 updateLiveStatePack 原地刷新文件里的 `## 0. 现在（实时）` 区块——
  // 只替换那一段，历史内容与增量的「状态更新」一个字节都不动，文件不会变厚。
  if ((cfg.groups ?? []).some((g) => g.statePack === true && g.enabled !== false) && activeGroup?.chatOnly === true) {
    try {
      const live = updateLiveStatePack(cfg.deliverDir, ctx.stateFingerprint, {
        reason: '边走边写',
        cfg,
        live: {
          title: pressure?.title ?? null,
          sessionId: target.id,
          chatLines: ctx.lastChatLines?.id === target.id ? ctx.lastChatLines.lines : null,
          ratio: pressure?.ratio ?? null,
        },
      })
      ctx.stateFingerprint = live.fingerprint
      if (live.changed && live.file) {
        log('info', `随身状态包已更新（${live.liveOnly ? '实时块' : '内容增量'}）：${live.file}`)
      }
      // 状态包同样是「每个工作区对话只开一次，之后往后续写」。
      // updateLiveStatePack 自己就会按 session 建档（state-pack-<sess8>.md），
      // 首次见到这个对话时写全量、之后只追加增量 + 刷实时块，所以这里不需要再补一份，
      // 否则同一个对话会多出一个只含全量的重复文件。
    } catch (error) {
      log('warn', `随身状态包更新失败（不影响监视）：${error?.message ?? error}`)
    }
  }
  log(
    'debug',
    `会话 ${target.id}（${pressure.title ?? '无标题'}）用量 ${usageText(pressure)}${candidates.length > 1 ? `；同时盯着另外 ${candidates.length - 1} 个会话` : ''}`,
  )

  // 接近阈值的提醒（只针对当前目标，避免多会话时刷屏）
  for (const mark of cfg.nearWarn ?? []) {
    const key = `${target.id}:${mark}`
    if (pressure.ratio >= mark && pressure.ratio < cfg.threshold && !ctx.warned.has(key)) {
      ctx.warned.add(key)
      log('info', `会话 ${target.id} 用量已达 ${(mark * 100).toFixed(0)}%（阈值 ${(cfg.threshold * 100).toFixed(0)}%）。`)
      if (cfg.notify) {
        const g = matchGroup(target, pressure, cfg)
        const where = g ? `导出到「${g.name}」目录` : `自动导出会话转写.md`
        notify('上下文哨兵', `会话「${pressure.title ?? target.id}」上下文已用 ${(mark * 100).toFixed(0)}%，到 ${(cfg.threshold * 100).toFixed(0)}% 时${where}。`)
      }
    }
  }

  const state = loadState()
  let dirty = false

  // 用量掉回（例如中间做了压缩/裁剪）：重新武装，下次再冲上来还会导出。
  // 2026-10-26 修复：原来只清 lastRatio、不清 frozen，而会话冻结后 lastRatio 早就是 0，
  // 于是这个分支永远进不去 → 90% 定格冻结一旦打上就再也解不开，续写和导出双双停摆
  // （这正是 10-25 16:48 之后归档再不更新的根因）。
  // 现在把「解冻」和「重新武装」放在一起做：frozen 只负责「别重复转储同一个文件」，不再阻断续写。
  for (const c of candidates) {
    const row = state.sessions?.[c.id]
    if (!row) continue
    const g = matchGroup(c, c.pressure, cfg)
    const th = g?.threshold ?? cfg.threshold
    if (c.pressure.ratio < th - 0.1) {
      if (num(row.lastRatio, 0) > 0) {
        row.lastRatio = 0
        dirty = true
      }
      if (row.frozen === true) {
        row.frozen = false
        row.frozenAt = 0
        log('info', `会话 ${c.id}（${c.pressure.title ?? '无标题'}）用量已掉回 ${pct(c.pressure.ratio)}，解除定格冻结——重新武装，继续续写与导出`)
        dirty = true
      }
    }
  }

  // 判定范围：
  //   - 写死的会话只判它自己；
  //   - 否则把所有候选都扫一遍（分组里 enableScanAll=true 的会强制全扫，即使全局 scanAll=false）
  const forceScanAll = (cfg.groups ?? []).some((g) => g.enableScanAll === true && g.enabled !== false)
  const checkList = pinned || (cfg.scanAll === false && !forceScanAll) ? [target] : candidates
  const exported = []
  for (const c of checkList) {
    const isTarget = c.id === target.id
    const forced = force && isTarget
    // 规矩：只要没有「真正换对话」的信号，就不真冻结——冻结会挡住续写。
    // 这里原本有一道 `if (isChatFrozen(c)) continue`，会让 90% 转储过的会话此后
    // 再也不导出、也不续写（实测 7 小时一条都没进）。现在彻底拿掉这道闸：
    // 输出去重本来就由 shouldExport 的 lastExportAt / reExportDelta / minReExportMs 负责，
    // 不需要再用「冻结」这种粗暴状态来兜。
    // 分组可以有自己的阈值（QQ 聊天默认 90%，比全局更早转存）
    const group = matchGroup(c, c.pressure, cfg)
    const threshold = group?.threshold ?? cfg.threshold
    if (!forced && c.pressure.ratio < threshold) continue
    const decision = shouldExport(state, c, c.pressure, cfg, forced, threshold)
    if (!decision.yes) {
      log('debug', `会话 ${c.id} 用量 ${pct(c.pressure.ratio)} 已超阈值 ${pct(threshold)}，但按去重规则暂不重复导出。`)
      continue
    }
    const { outFile, memoryPath, frozen } = await exportTranscript(c, c.pressure, cfg, decision.reason)
    if (frozen) continue
    recordExport(state, c, c.pressure, cfg, outFile, decision.reason)
    // **不要因为到了阈值就停**。
    // 到 90%/98% 只是到了「该同步一份进记忆库」的时机，压缩会自动接手；
    // 真正撑不住是会话自己撞上模型输入上限（400），不是哨兵在这里替它判断。
    // 所以这里不再 freezeSession——对话和状态包都会一直续写到对话真的结束。
    exported.push(outFile)
    if (cfg.notify) {
      notify(
        '上下文哨兵',
        `会话「${c.pressure.title ?? c.id}」上下文已用 ${pct(c.pressure.ratio)}（${fmtInt(c.pressure.usedTokens)}/${fmtInt(c.pressure.contextWindow)}），已导出 ${path.basename(outFile)} 到 ${path.dirname(outFile)}${memoryPath ? '，并已同步进长期记忆' : ''}。`,
      )
    }
  }
  if (dirty) saveState(state)
  if (exported.length) return { ok: true, exported, target, pressure }
  return { ok: true, exported: [], target, pressure }
}

function statusReport(cfg) {
  const pidInfo = readJson(PATHS.pid)
  const hb = readJson(PATHS.heartbeat)
  const alive = pidAlive(num(pidInfo?.pid, 0))
  const age = heartbeatAgeMs()
  const state = loadState()
  const resolved = resolveTargets(cfg)
  const line = []
  line.push(`上下文哨兵 v${VERSION}`)
  line.push(`  进程：${alive ? `运行中（pid ${pidInfo.pid}，心跳 ${Number.isFinite(age) ? `${Math.round(age / 1000)} 秒前` : '无'}）` : '未运行'}`)
  line.push(`  配置：${cfg.configPath}${existsSync(cfg.configPath) ? '' : '（不存在，使用内置默认值）'}`)
  line.push(`  日志：${PATHS.log}`)
  line.push(`  阈值：${(cfg.threshold * 100).toFixed(0)}%   轮询：${cfg.pollMs / 1000}s   目标设置：${cfg.sessionId}${cfg.sessionId === 'auto' ? `（auto${cfg.scanAll ? '，同时盯所有会话' : ''}）` : ''}`)
  line.push(`  投递：${path.join(cfg.deliverDir, cfg.fileName)}${existsSync(path.join(cfg.deliverDir, cfg.fileName)) ? '（已存在）' : ''}`)
  for (const g of cfg.groups ?? []) {
    if (g.enabled === false) continue
    const gDir = path.isAbsolute(g.dir) ? g.dir : path.join(cfg.deliverDir, g.dir)
    let count = 0
    try {
      count = readdirSync(gDir).filter((n) => n.endsWith('.md') && n !== '索引.md').length
    } catch {
      /* 目录还没建 */
    }
    line.push(`  分组「${g.name}」→ ${gDir}（阈值 ${((g.threshold ?? cfg.threshold) * 100).toFixed(0)}%，已有 ${count} 份${g.keepEvery === false ? '' : '，永不覆盖'}）`)
  }
  if (resolved.error) {
    line.push(`  目标会话：${resolved.error}`)
  } else {
    const { target, candidates, pinned } = resolved
    line.push(`  目标会话：${target.id}${target.pressure.title ? `（${target.pressure.title}）` : ''}${pinned ? '［配置写死］' : '［你最近发过话］'}`)
    line.push(`  当前用量：${usageText(target.pressure)}`)
    if (target.pressure.reportedTokens !== null) {
      line.push(
        `            provider 上次回报 ${fmtInt(target.pressure.reportedTokens)}，表面估算 ${fmtInt(target.pressure.surfaceTokens)}（采样 ${fmtInt(target.pressure.sampledSurfaceTokens)}）`,
      )
    }
    const row = state.sessions?.[target.id]
    if (row?.lastExportAt) {
      const ratioAtExport = row.lastRatioAtExport ?? row.lastRatio
      line.push(`  上次导出：${stamp(row.lastExportAt)}（导出时用量 ${ratioAtExport !== null && ratioAtExport !== undefined ? pct(ratioAtExport) : '?'}，原因：${row.lastReason ?? '?'}）`)
    } else {
      line.push('  上次导出：本会话还没有导出过')
    }
    if (candidates.length > 1) {
      line.push(`  同时在盯：还有 ${candidates.length - 1} 个会话`)
      for (const c of candidates.slice(0, 6)) {
        if (c.id === target.id) continue
        line.push(`            · ${pct(c.pressure.ratio).padStart(6)}  ${c.id.slice(8, 16)}  ${c.pressure.title ?? '无标题'}`)
      }
    }
  }
  if (hb && hb.time) {
    line.push(`  心跳快照：${stamp(hb.time)} 会话 ${hb.sessionId ?? '?'} 用量 ${hb.ratio !== null && hb.ratio !== undefined ? pct(hb.ratio) : '?'}`)
  }
  return line.join('\n')
}

function parseArgv(argv) {
  const out = { flags: new Set(), values: {} }
  for (const a of argv) {
    if (!a.startsWith('-')) continue
    const body = a.replace(/^-+/, '')
    const eq = body.indexOf('=')
    if (eq === -1) out.flags.add(body)
    else out.values[body.slice(0, eq)] = body.slice(eq + 1)
  }
  return out
}

const HELP = `上下文哨兵 v${VERSION}（Windows 版）

用法：node ctx-sentinel.js [选项]

  （无选项）            常驻监视目标会话，到阈值导出 会话转写.md
  --status              打印一次状态后退出
  --once                只检查一次（达到阈值仍会导出）
  --export-now          立刻导出一次，不看阈值
  --session=<会话id>    临时指定目标会话（也支持 auto）
  --threshold=<0.98|98> 临时改阈值
  --deliver=<目录>      临时改投递目录
  --config=<文件>       临时改配置文件
  --verbose             每次轮询都写日志
  --no-notify           不弹通知
  --help                显示本帮助

配置文件默认：${PATHS.config}
日志：${PATHS.log}
`

async function main() {
  const cli = parseArgv(process.argv.slice(2))
  if (cli.flags.has('help')) {
    process.stdout.write(HELP)
    return 0
  }
  LOG_VERBOSE = cli.flags.has('verbose')
  rotateLog()
  const cfg = loadConfig(cli)

  if (cli.flags.has('status')) {
    process.stdout.write(statusReport(cfg) + '\n')
    return 0
  }

  if (cli.flags.has('once') || cli.flags.has('export-now')) {
    const force = cli.flags.has('export-now')
    const result = await tick(cfg, { lastTargetId: null, warned: new Set() }, { force })
    dumpBufferedLog()
    if (result?.error) {
      process.stdout.write(`⚠️ ${result.error}\n`)
      return 1
    }
    if (result?.exported?.length) {
      for (const f of result.exported) process.stdout.write(`✅ 已导出：${f}\n`)
    } else if (result?.pressure) {
      process.stdout.write(
        `✅ 检查完成：会话 ${result.target.id} 用量 ${pct(result.pressure.ratio)}（阈值 ${(cfg.threshold * 100).toFixed(0)}%），本次未导出。\n`,
      )
    } else {
      process.stdout.write('✅ 检查完成。\n')
    }
    return 0
  }

  if (!claimSingleInstance()) return 0

  log('info', `上下文哨兵 v${VERSION} 启动（pid ${process.pid}，阈值 ${(cfg.threshold * 100).toFixed(0)}%，轮询 ${cfg.pollMs / 1000}s，投递 ${cfg.deliverDir}）`)
  if (!existsSync(cfg.configPath)) log('info', `配置文件不存在，使用内置默认值：${cfg.configPath}`)

  let stopping = false
  const stop = (signal) => {
    if (stopping) return
    stopping = true
    log('info', `收到 ${signal}，哨兵退出。`)
    try {
      writeFileSync(PATHS.pid, JSON.stringify({ pid: 0, stoppedAt: Date.now() }), 'utf8')
    } catch {
      /* ignore */
    }
    process.exit(0)
  }
  process.on('SIGINT', () => stop('SIGINT'))
  process.on('SIGTERM', () => stop('SIGTERM'))
  process.on('uncaughtException', (error) => log('error', `未捕获异常：${error?.stack ?? error}`))
  process.on('unhandledRejection', (error) => log('error', `未处理的 Promise 拒绝：${error?.stack ?? error}`))

  const ctx = { lastTargetId: null, warned: new Set(), stateFingerprint: null, lastChatLines: null }
  let lastHeartbeatLog = 0
  while (!stopping) {
    const started = Date.now()
    try {
      await tick(cfg, ctx)
    } catch (error) {
      log('error', `本轮监视出错：${error?.stack ?? error}`)
    }
    dumpBufferedLog()
    if (Date.now() - lastHeartbeatLog > 5 * 60_000) {
      lastHeartbeatLog = Date.now()
      const info = readJson(PATHS.heartbeat)
      log('info', `心跳：${info?.sessionId ?? '无目标'} 用量 ${info?.ratio !== null && info?.ratio !== undefined ? `${(100 * info.ratio).toFixed(1)}%` : '?'}`)
    }
    const wait = Math.max(1000, cfg.pollMs - (Date.now() - started))
    await sleep(wait)
  }
  return 0
}

/**
 * 我是不是被当成主脚本直接跑的？
 *
 * 不能只比字符串：插件目录可能是 junction / symlink（指向别处的真身），
 * Node 会把 ESM 入口解析成真实路径，于是 import.meta.url 是真身路径、
 * process.argv[1] 是链接路径，字符串一比就不相等 —— 哨兵会一声不响地立刻退出。
 * 所以两边都取真实路径再比。
 */
function isMainModule() {
  if (!process.argv[1]) return false
  const self = fileURLToPath(import.meta.url)
  const invoked = path.resolve(process.argv[1])
  if (invoked === self) return true
  try {
    const a = realpathSync.native ? realpathSync.native(invoked) : realpathSync(invoked)
    const b = realpathSync.native ? realpathSync.native(self) : realpathSync(self)
    return a.toLowerCase() === b.toLowerCase()
  } catch {
    return false
  }
}

if (isMainModule()) {
  main()
    .then((code) => process.exit(code ?? 0))
    .catch((error) => {
      log('error', `致命错误：${error?.stack ?? error}`)
      process.exit(1)
    })
}