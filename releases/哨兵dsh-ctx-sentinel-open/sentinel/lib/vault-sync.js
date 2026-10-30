/**
 * 把 QQ 聊天记录同步进长期记忆仓库（DSH Memory Vault）。
 *
 * 为什么能直接写文件：仓库扫描器（dsh-longterm-memory 的 scanVault）以仓库根为
 * 起点递归 4 层，只要 Markdown 带 `id` frontmatter 就会被认成一条记忆，
 * 正文进 body → 全文可检索。所以这里不需要插件配合，写文件即可。
 *
 * 唯一的坑：插件只在**启动时**做一次增量同步（reconcileIndexWithMarkdown），
 * 平时往仓库里丢文件，索引是不知道的。所以写完要戳一下它的 HTTP 接口
 * `POST /dsh-longterm-memory/api/syncIndex`，让索引立刻跟上。
 * 端口是每次启动随机的（GUI 地址里的那个），靠 listening 端口探测。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const API_PATH = '/dsh-longterm-memory/api'

/** 从 profile 的 cordis.patch.yml 里读长期记忆插件配置的仓库路径（找不到就返回 null）。 */
export function discoverVaultPath(dshHome) {
  const home = dshHome || path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh')
  for (const profile of ['desktop', 'web', 'default']) {
    const file = path.join(home, 'profiles', profile, 'cordis.patch.yml')
    if (!existsSync(file)) continue
    try {
      const raw = readFileSync(file, 'utf8')
      const m = /^\s*vaultPath:\s*(.+?)\s*$/m.exec(raw)
      if (m) {
        const p = m[1].replace(/^['"]|['"]$/g, '').trim()
        if (p) return p.replace(/\//g, path.sep)
      }
    } catch {
      /* 读不动就换下一个 profile */
    }
  }
  return null
}

/** 探测 DSH 的 web 端口：找 DSH/electron 进程正在 listen 的 loopback 端口。 */
function listeningPortsOfDsh() {
  // 注意：进程名是 "DeepSeek Harness"（带空格），按 'dsh|electron' 过滤会一个都匹配不到，
  // 所以这里按可执行文件路径匹配 deepseek，并优先试较大的端口（GUI 端口一般偏大）。
  const ps = `
$ErrorActionPreference='SilentlyContinue'
$procs = Get-Process | Where-Object { ($_.ProcessName -match 'DeepSeek|dsh|electron') -or ($_.Path -match 'deepseek') }
$pids = $procs | Select-Object -ExpandProperty Id
if (-not $pids) { exit 0 }
$conns = Get-NetTCPConnection -State Listen -OwningProcess $pids -ErrorAction SilentlyContinue
$conns | Where-Object { $_.LocalAddress -eq '127.0.0.1' -or $_.LocalAddress -eq '::1' } | Select-Object -ExpandProperty LocalPort | Sort-Object -Descending -Unique
`.trim()
  try {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15_000,
    })
    const out = String(r.stdout ?? '')
    return out
      .split(/\r?\n/)
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 1024 && n < 65536)
  } catch {
    return []
  }
}

let cachedPort = null

async function callApi(port, method, payload = {}) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 4000)
  try {
    const res = await fetch(`http://127.0.0.1:${port}${API_PATH}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    })
    if (!res.ok) return null
    const json = await res.json()
    return json?.ok ? json.data : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** 找到能应答长期记忆接口的那个端口（结果缓存）。 */
export async function discoverPort() {
  if (cachedPort) return cachedPort
  const candidates = listeningPortsOfDsh()
  for (const port of candidates) {
    const data = await callApi(port, 'status')
    if (data && typeof data === 'object') {
      cachedPort = port
      return port
    }
  }
  return null
}

/** 让插件立刻把新写的 Markdown 收进索引；找不到接口就返回 false（不影响导出本身）。 */
export async function syncVaultIndex() {
  const port = await discoverPort()
  if (!port) return { ok: false, reason: '未找到长期记忆接口（DSH 未运行或端口不可达）' }
  const data = await callApi(port, 'syncIndex')
  if (!data) return { ok: false, reason: `syncIndex 调用失败（端口 ${port}）` }
  return { ok: true, port, added: data.added?.length ?? 0, updated: data.updated?.length ?? 0, removed: data.removed?.length ?? 0 }
}

function pad(n) {
  return String(n).padStart(2, '0')
}

function isoLocal(ms) {
  const d = new Date(ms)
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  )
}

function slug(s) {
  return (
    String(s ?? '')
      .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60) || '无标题'
  )
}

/** 稳定 id：同一会话反复导出只更新同一条记忆，不会在仓库里堆一堆。 */
function memoryId(sessionId) {
  const short = String(sessionId ?? '').replace(/^session-/, '').slice(0, 8) || 'unknown'
  return `qq_${short}`
}

/** 在目录里找 frontmatter id 命中的那个文件（用于更新而非新建）。 */
function findByDir(dir, id) {
  if (!existsSync(dir)) return null
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.md')) continue
    const file = path.join(dir, name)
    try {
      const raw = readFileSync(file, 'utf8')
      const m = /^id:\s*(\S+)\s*$/m.exec(raw.slice(0, 4000))
      if (m && m[1] === id) return file
    } catch {
      /* 读不动就跳过 */
    }
  }
  return null
}

/**
 * 把一段聊天写进仓库。
 * @returns {{ok:boolean, file?:string, id?:string, reason?:string}}
 */
export function writeChatNote({ lines, meta = {}, vault, dir = 'QQ聊天', stats = {}, markdown = null, botName = 'AI' }) {
  if (!vault) return { ok: false, reason: '未配置记忆仓库路径（sentinel-target.json 的 memoryVault）' }
  if (!existsSync(vault)) return { ok: false, reason: `记忆仓库不存在：${vault}` }
  const hasLines = Array.isArray(lines) && lines.length > 0
  if (!hasLines && !markdown) return { ok: false, reason: '没有可写入的对话' }

  const id = memoryId(meta.sessionId)
  const targetDir = path.join(vault, dir)
  try {
    mkdirSync(targetDir, { recursive: true })
  } catch (error) {
    return { ok: false, reason: `建目录失败：${error?.message ?? error}` }
  }

  const safeLines = hasLines ? lines : []
  const title = `QQ 聊天 · ${meta.title || (safeLines[0] ? safeLines[0].name : '') || '未命名会话'}`
  const now = Date.now()
  const createdAt = safeLines.length ? new Date(safeLines[0].time || now) : new Date(now)
  const existing = findByDir(targetDir, id)
  const createdIso = isoLocal(createdAt.getTime())

  const peers = [...new Set(safeLines.filter((l) => l.side === 'in').map((l) => l.name).filter(Boolean))]
  const tags = ['qq', '聊天记录', ...(peers.length ? [peers[0]] : [])].slice(0, 6)

  const head = [
    '---',
    `id: ${id}`,
    'type: experience',
    'status: active',
    `title: ${title}`,
    `created_at: ${createdIso}`,
    `updated_at: ${isoLocal(now)}`,
    `tags: [${tags.join(', ')}]`,
    'confidence: high',
    'importance: 60',
    'pinned: false',
    `source_sessions: ["${meta.sessionId ?? ''}"]`,
    `evidence: 上下文哨兵从会话日志 session.v4.jsonl.zstd 解出（原始日志 ${meta.logPath ?? '?'}）`,
    'schema_version: 1',
    '---',
    '',
  ].join('\n')

  const body = []
  body.push(`# ${title}`)
  body.push('')
  body.push('## 核心内容')
  body.push('')
  if (peers.length) body.push(`聊天对象：${peers.join('、')}`)
  if (meta.sessionId) body.push(`会话 ID：\`${meta.sessionId}\``)
  if (meta.cwd) body.push(`工作目录：\`${meta.cwd}\``)
  if (hasLines) body.push(`条数：${safeLines.length}（去重丢弃 ${stats.dropped ?? 0} 条）`)
  body.push('')
  let day = ''
  for (const line of safeLines) {
    const d = new Date(line.time)
    const key = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    if (key !== day) {
      day = key
      body.push(`### ${key}`)
      body.push('')
    }
    const who = line.side === 'out' ? botName : line.name
    body.push(`- \`${pad(d.getHours())}:${pad(d.getMinutes())}\` ${who}：${line.text.replace(/\r?\n/g, ' ⏎ ')}`)
  }
  if (!hasLines && markdown) {
    // 剥不出对话（chatOnly 回退）时，至少把整份转写交进仓库，保证不丢东西
    body.push('> 本次未能从日志里剥出结构化对话，以下为完整转写：')
    body.push('')
    body.push(markdown)
  }
  body.push('')
  body.push('## 来源与依据')
  body.push('')
  body.push(`上下文哨兵在会话用量 ${meta.ratio != null ? `${(meta.ratio * 100).toFixed(1)}%` : '手动触发'} 时导出；` + `本文件由 sentinel 自动写入，可在长期记忆里直接检索。`)
  body.push('')
  body.push('## 相关记忆')
  body.push('')
  body.push('- （暂无）')
  body.push('')

  const content = head + body.join('\n')
  const file = existing ?? path.join(targetDir, `${slug(title)}-${id}.md`)
  try {
    writeFileSync(file, content, 'utf8')
  } catch (error) {
    return { ok: false, reason: `写入失败：${error?.message ?? error}` }
  }
  return { ok: true, file, id, updated: Boolean(existing) }
}
