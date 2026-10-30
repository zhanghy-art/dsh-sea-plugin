/**
 * DSH v4 会话日志：解码 + 转写（上下文哨兵内部模块，Windows 版）
 *
 * DSH 的会话日志 `session.v4.jsonl.zstd` 是「追加式 zstd 帧」：
 * 每一帧是一段独立压缩的 JSONL，帧首魔数 0x28B52FFD，帧与帧直接首尾相接。
 * Node 的 zstdDecompressSync 只解第一帧、静默忽略尾部，所以这里逐帧走：
 * 先用「指数扩张 + 二分」找出当前帧的精确结束偏移，再解下一帧。
 *
 * 对外两个入口：
 *   decodeSessionLog(file)   → { text, frames, bytes }
 *   renderTranscript(...)    → 会话转写.md 的 Markdown 正文
 */

import { readFileSync } from 'node:fs'
import * as zlib from 'node:zlib'

/** 上下文哨兵默认的转写参数（可在 sentinel-target.json 里覆盖）。 */
export const DEFAULT_RENDER_OPTIONS = {
  includeReasoning: false, // 是否把模型思考写进会话转写.md
  maxReasoningChars: 1200,
  maxToolArgsChars: 1200,
  maxToolResultChars: 2000,
  maxAssistantChars: 0, // 0 = 不截断助手正文
  maxUserChars: 0, // 0 = 不截断用户正文
  maxTotalChars: 6_000_000, // 整份文件的安全上限
  includeSystemNotices: true, // 审批变更 / 后台任务 / 交付文件等提示行
}

const MAX_FRAMES = 200_000
const FRAME_SEED = 256

function zstd(buf) {
  if (typeof zlib.zstdDecompressSync !== 'function') {
    throw new Error('当前 Node 缺少 zstdDecompressSync（需要 Node ≥ 22.15），无法读取 DSH 会话日志')
  }
  return zlib.zstdDecompressSync(buf)
}

/** 找出从 pos 开始的这一帧压缩数据到哪个偏移结束（含端点，不含下一帧）。 */
function frameEndAt(buf, pos, seed) {
  let hi = Math.min(buf.length, pos + Math.max(64, seed))
  while (hi < buf.length) {
    try {
      zstd(buf.subarray(pos, hi))
      break
    } catch {
      hi = Math.min(buf.length, hi * 2)
    }
  }
  let lo = pos + 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    let ok = true
    try {
      zstd(buf.subarray(pos, mid))
    } catch {
      ok = false
    }
    if (ok) hi = mid
    else lo = mid + 1
  }
  return lo
}

/**
 * 解码整个会话日志（追加式 zstd 帧 → 完整 JSONL 文本）。
 * 单帧损坏时停在损坏处并返回已解出的部分，不抛异常。
 */
export function decodeSessionLog(file) {
  const buf = readFileSync(file)
  const parts = []
  let pos = 0
  let seed = FRAME_SEED
  let frames = 0
  let stopped = null
  while (pos < buf.length && frames < MAX_FRAMES) {
    let out
    try {
      out = zstd(buf.subarray(pos))
    } catch (error) {
      stopped = error?.message ?? String(error)
      break
    }
    if (!out.length) break
    parts.push(out)
    frames += 1
    const end = frameEndAt(buf, pos, seed)
    if (end <= pos) {
      stopped = '帧边界解析失败'
      break
    }
    seed = end - pos
    pos = end
  }
  const text = Buffer.concat(parts).toString('utf8')
  return { text, frames, bytes: buf.length, consumed: pos, stopped }
}

/** JSONL → 事件数组（坏行跳过）。 */
export function parseEvents(text) {
  const events = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const ev = JSON.parse(trimmed)
      if (ev && typeof ev === 'object') events.push(ev)
    } catch {
      /* 追加写入时的半行，直接跳过 */
    }
  }
  return events
}

function fmtInt(n) {
  if (!Number.isFinite(n)) return String(n)
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

function fmtPercent(ratio) {
  if (!Number.isFinite(ratio)) return '未知'
  return `${(ratio * 100).toFixed(1)}%`
}

function fmtTime(ms) {
  if (!Number.isFinite(ms)) return '未知'
  const d = new Date(ms)
  const p = (n, w = 2) => String(n).padStart(w, '0')
  const offsetMin = -d.getTimezoneOffset()
  const sign = offsetMin >= 0 ? '+' : '-'
  const abs = Math.abs(offsetMin)
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} (${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)})`
}

function truncate(text, cap) {
  const s = String(text ?? '')
  if (!cap || s.length <= cap) return { text: s, truncated: false, total: s.length }
  return { text: s.slice(0, cap), truncated: true, total: s.length }
}

/** 生成一段安全围栏：内容里已有 ``` 时自动加长围栏。 */
function fence(body, lang = '') {
  const s = String(body ?? '')
  let ticks = '```'
  while (s.includes(ticks)) ticks += '`'
  return `${ticks}${lang}\n${s.replace(/\s+$/, '')}\n${ticks}`
}

/** 提取消息 content 里的文本部分（text / reasoning / tool-call / image）。 */
function partsOf(message) {
  const content = Array.isArray(message?.content) ? message.content : []
  return content
}

const SKIP_USER_SOURCES = new Set([
  'runtime-context',
  'skill-catalog',
  'time-context',
  'plugin:hindsight',
  'plugin',
])

function userKind(ev) {
  return ev?.data?.source?.kind ?? 'user'
}

function textOfParts(parts, types) {
  const out = []
  for (const p of parts) {
    if (!types.includes(p?.type)) continue
    if (typeof p.text === 'string') out.push(p.text)
    else if (p.type === 'image') out.push('[图片]')
    else if (p.type === 'tool-call') out.push(`[工具调用 ${p.name ?? ''}]`)
  }
  return out.join('\n\n')
}

/**
 * 事件流 → 会话转写.md
 *
 * meta: { title, sessionId, cwd, logPath, exportedAt, reason, threshold,
 *         ratio, surfaceTokens, contextWindow, model, tokens, stats, options }
 */
export function renderTranscript({ events, meta = {}, options = {} }) {
  const opt = { ...DEFAULT_RENDER_OPTIONS, ...options }
  const lines = []
  const stats = { userMessages: 0, assistantMessages: 0, toolCalls: 0, toolResults: 0, errors: 0, turns: 0 }

  // ---------- 抬头 ----------
  const title = meta.title || '(未命名会话)'
  lines.push(`# 会话转写 · ${title}`)
  lines.push('')
  if (Number.isFinite(meta.ratio)) {
    const used = Number.isFinite(meta.usedTokens) ? meta.usedTokens : meta.surfaceTokens
    lines.push(
      `> 上下文哨兵在会话用量 **${fmtPercent(meta.ratio)}** 时导出` +
        (Number.isFinite(used) && Number.isFinite(meta.contextWindow)
          ? `（${fmtInt(used)} / ${fmtInt(meta.contextWindow)} tokens）`
          : '') +
        `${meta.reason ? ` · 触发原因：${meta.reason}` : ''}`,
    )
  } else {
    lines.push('> 上下文哨兵导出（手动触发）。')
  }
  lines.push('')
  lines.push('| 项目 | 值 |')
  lines.push('| --- | --- |')
  lines.push(`| 会话 ID | \`${meta.sessionId ?? '?'}\` |`)
  lines.push(`| 工作区 | \`${meta.cwd ?? '?'}\` |`)
  if (meta.model) lines.push(`| 模型 | ${meta.model} |`)
  if (meta.tokens) {
    lines.push(
      `| Token 累计 | 未缓存输入 ${fmtInt(meta.tokens.uncachedInputTokens ?? 0)} · 缓存读 ${fmtInt(meta.tokens.cacheReadTokens ?? 0)} · 输出 ${fmtInt(meta.tokens.outputTokens ?? 0)} |`,
    )
  }
  if (meta.stats) {
    lines.push(
      `| 轮次 / 步骤 / 工具调用 | ${fmtInt(meta.stats.turns ?? stats.turns ?? 0)} / ${fmtInt(meta.stats.steps ?? 0)} / ${fmtInt(meta.stats.toolCalls || stats.toolCalls)} |`,
    )
  }
  lines.push(`| 导出时间 | ${fmtTime(meta.exportedAt ?? Date.now())} |`)
  if (meta.logPath) lines.push(`| 原始日志 | \`${meta.logPath}\` |`)
  lines.push('')
  lines.push('> 本文件是会话的可读转写（用户提问 · 助手回复 · 工具调用与结果），用于在上下文用满前把工作交接给新会话。')
  lines.push('')
  lines.push('---')
  lines.push('')

  // ---------- 正文 ----------
  let currentTurn = 0
  let bodyChars = 0
  let clipped = false

  const push = (s) => {
    if (clipped) return
    bodyChars += s.length
    if (bodyChars > opt.maxTotalChars) {
      clipped = true
      lines.push('')
      lines.push(`> ⚠️ 转写达到体积上限（${fmtInt(opt.maxTotalChars)} 字符），后续内容已省略。可调大 sentinel-target.json 的 maxTotalChars。`)
      return
    }
    lines.push(s)
  }

  const headings = []
  for (const ev of events) {
    if (ev.type === 'turn/start') {
      currentTurn = ev.data?.turn ?? currentTurn + 1
      stats.turns += 1
      push(`## 轮次 ${currentTurn}${ev.time ? ` · ${fmtTime(ev.time)}` : ''}`)
      push('')
      continue
    }

    if (ev.type === 'user/message') {
      const kind = userKind(ev)
      if (kind === 'user') {
        stats.userMessages += 1
        push('### 👤 用户')
        push('')
        const t = truncate(textOfParts(partsOf(ev.data), ['text', 'image']), opt.maxUserChars)
        push(t.text)
        if (t.truncated) push(`\n> （用户消息过长，已截断；原文 ${fmtInt(t.total)} 字符）`)
        push('')
      } else if (opt.includeSystemNotices && (kind === 'user-approval' || kind === 'tool-jobs')) {
        const t = truncate(textOfParts(partsOf(ev.data), ['text']), 400)
        push(`> 🔔 ${t.text.replace(/\n+/g, ' ')}`)
        push('')
      }
      continue
    }

    if (ev.type === 'assistant/message') {
      const parts = partsOf(ev.data?.message)
      const text = textOfParts(parts, ['text'])
      const reasoning = opt.includeReasoning ? textOfParts(parts, ['reasoning']) : ''
      if (!text && !reasoning) continue
      stats.assistantMessages += 1
      push('### 🤖 助手')
      push('')
      if (reasoning) {
        const t = truncate(reasoning, opt.maxReasoningChars)
        push('<details><summary>💭 思考' + (t.truncated ? '（已截断）' : '') + '</summary>')
        push('')
        push(t.text)
        push('')
        push('</details>')
        push('')
      }
      const t = truncate(text, opt.maxAssistantChars)
      if (t.text) push(t.text)
      if (t.truncated) push(`\n> （助手正文过长，已截断；原文 ${fmtInt(t.total)} 字符）`)
      push('')
      continue
    }

    if (ev.type === 'tool/call') {
      stats.toolCalls += 1
      const name = ev.data?.name ?? 'tool'
      const t = truncate(String(ev.data?.arguments ?? ''), opt.maxToolArgsChars)
      push(`#### 🔧 工具调用 \`${name}\``)
      push('')
      push(fence(t.text + (t.truncated ? `\n…（参数已截断，原文 ${fmtInt(t.total)} 字符）` : ''), 'json'))
      push('')
      continue
    }

    if (ev.type === 'tool/result') {
      stats.toolResults += 1
      const t = truncate(textOfParts(partsOf(ev.data?.message), ['text', 'image']), opt.maxToolResultChars)
      push(`#### 📄 工具结果`)
      push('')
      push(fence(t.text + (t.truncated ? `\n…（结果已截断，原文 ${fmtInt(t.total)} 字符）` : ''), 'text'))
      push('')
      continue
    }

    if (ev.type === 'turn/end') {
      const reason = ev.data?.reason
      if (reason?.kind === 'error') {
        stats.errors += 1
        const msg = reason.error?.message ?? reason.error?.code ?? JSON.stringify(reason)
        push(`> ❌ 本轮出错：${String(msg).replace(/\n+/g, ' ').slice(0, 600)}`)
        push('')
      }
      continue
    }

    if (ev.type === 'command/run') {
      const { name, args } = ev.data ?? {}
      push(`> ⌘ 命令：/${name}${args ?? ''}`)
      push('')
      continue
    }

    if (ev.type === 'model/selection') {
      const { provider, model } = ev.data ?? {}
      push(`> ⚙️ 切换模型：${provider ?? '?'} / ${model ?? '?'}`)
      push('')
      continue
    }

    if (ev.type === 'permission/preset' || ev.type === 'sandbox/mode' || ev.type === 'approval/policy') {
      if (!opt.includeSystemNotices) continue
      const [k, v] = Object.entries(ev.data ?? {})[0] ?? ['', '']
      push(`> ⚙️ ${ev.type} → ${k}=${v}`)
      push('')
      continue
    }

    if (ev.type === 'deliverables/presented') {
      const files = Array.isArray(ev.data?.files) ? ev.data.files : []
      if (files.length) {
        push(`> 📎 交付文件：`)
        for (const f of files) push(`> - \`${f.path}\`${f.description ? ` — ${f.description}` : ''}`)
        push('')
      }
      continue
    }

    if (ev.type === 'session/title') {
      headings.push(ev.data?.title)
      continue
    }
  }

  lines.push('')
  lines.push('---')
  lines.push('')
  lines.push('## 📊 本次转写统计')
  lines.push('')
  lines.push(
    `用户提问 ${stats.userMessages} 条 · 助手回复 ${stats.assistantMessages} 条 · 工具调用 ${stats.toolCalls} 次 · 工具结果 ${stats.toolResults} 条 · 报错 ${stats.errors} 次`,
  )
  lines.push('')

  return lines.join('\n')
}

export const __internals = { frameEndAt, truncate, fence, fmtTime, fmtInt }