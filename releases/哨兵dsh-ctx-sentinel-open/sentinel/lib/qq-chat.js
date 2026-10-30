/**
 * 从会话事件流里剥出「双方在 QQ 上的对话」，别的统统不要。
 *
 * 为什么要单独一个模块：QQ 会话的 user/message 里塞满了桥接提示词（身份、令牌、
 * 反 AI 味、唤醒配置、表情包策略……），assistant 侧全是思考与工具调用。
 * 用户要的是「聊天记录」，所以只留两条水流：
 *
 *   进来的 → user/message（source.kind === 'user'）正文末尾的【本次消息快照】JSON
 *            messages[]（对方说的）+ recent[]（isSelf 的是机器人自己说过的）
 *   出去的 → tool/call 里 mcp__snowluma__qq_send_* 的 arguments.messages
 *
 * 【本次消息快照】那段 JSON 在真实日志里**经常被 DSH 截断**（实测结尾停在
 * `"readThroughSeq` 就断），所以这里全部走「容错扫描 + 字段抢救」，绝不 JSON.parse 整段。
 */

/** 默认显示名（调用方可用 setBotName 覆盖，或给各渲染函数传 opts.botName）。 */
let BOT_NAME = 'AI'

/** 设置机器人自己的显示名（影响「谁说的」那一列）。 */
export function setBotName(name) {
  if (name) BOT_NAME = String(name)
}

/** 机器人往外发消息用的工具名（arguments 里带 messages）。 */
export const QQ_SEND_TOOLS = new Set([
  'mcp__snowluma__qq_send_message',
  'mcp__snowluma__qq_send_burst',
  'mcp__snowluma__qq_send_group_message',
  'mcp__snowluma__qq_send_private_message',
  'mcp__snowluma__qq_reply',
])

/** 快照里标记「本次消息快照」的锚点。 */
const SNAPSHOT_ANCHOR = '【本次消息快照】'

/**
 * 容错地把一段（可能被截断的）JSON 数组切成若干对象切片。
 * 会在字符串里正确跳过引号与转义；数组尾部被截断时，最后一段作为 partial 返回。
 */
function sliceJsonObjects(text, arrayStart) {
  const slices = []
  let depth = 0
  let start = -1
  let inStr = false
  let esc = false
  for (let i = arrayStart; i < text.length; i += 1) {
    const c = text[i]
    if (inStr) {
      if (esc) { esc = false; continue }
      if (c === '\\') { esc = true; continue }
      if (c === '"') inStr = false
      continue
    }
    if (c === '"') { inStr = true; continue }
    if (c === '{') {
      if (depth === 0) start = i
      depth += 1
    } else if (c === '}') {
      depth -= 1
      if (depth === 0 && start >= 0) {
        slices.push({ text: text.slice(start, i + 1), partial: false })
        start = -1
      }
    } else if (c === ']' && depth === 0) {
      break
    }
  }
  if (depth > 0 && start >= 0) slices.push({ text: text.slice(start), partial: true })
  return slices
}

const FIELD_RE = {
  seq: /"seq"\s*:\s*(-?\d+)/,
  messageId: /"messageId"\s*:\s*"([^"]*)"/,
  sender: /"sender"\s*:\s*"((?:[^"\\]|\\.)*)"/,
  userId: /"userId"\s*:\s*"([^"]*)"/,
  text: /"text"\s*:\s*"((?:[^"\\]|\\.)*)"/,
  at: /"at"\s*:\s*"([^"]*)"/,
  ago: /"ago"\s*:\s*"([^"]*)"/,
  isSelf: /"isSelf"\s*:\s*(true|false)/,
  isOwner: /"isOwner"\s*:\s*(true|false)/,
  hasMedia: /"hasMedia"\s*:\s*(true|false)/,
}

function unescape(s) {
  try {
    return JSON.parse(`"${s}"`)
  } catch {
    return s
  }
}

/** 先试整段 JSON.parse，失败（被截断/脏字符）就按字段抢救。 */
function parseEntry(slice) {
  if (!slice.partial) {
    try {
      return JSON.parse(slice.text)
    } catch {
      /* 落到抢救分支 */
    }
  }
  const out = {}
  for (const [key, re] of Object.entries(FIELD_RE)) {
    const m = re.exec(slice.text)
    if (!m) continue
    if (key === 'seq') out.seq = Number(m[1])
    else if (key === 'isSelf' || key === 'isOwner' || key === 'hasMedia') out[key] = m[1] === 'true'
    else out[key] = unescape(m[1])
  }
  return out
}

/** 找到 key 对应的数组起点（`"messages":[`）。 */
function arrayStartAfter(text, key, from = 0) {
  const idx = text.indexOf(`"${key}"`, from)
  if (idx < 0) return -1
  const bracket = text.indexOf('[', idx)
  return bracket < 0 ? -1 : bracket + 1
}

/**
 * 从一条 user/message 的正文里取出 QQ 消息快照。
 * @returns {{messages: Array, recent: Array, raw: string}|null}
 */
export function extractSnapshot(bodyText) {
  const anchor = bodyText.indexOf(SNAPSHOT_ANCHOR)
  if (anchor < 0) return null
  const region = bodyText.slice(anchor + SNAPSHOT_ANCHOR.length)
  const objStart = region.indexOf('{')
  if (objStart < 0) return null

  const messages = []
  const recent = []
  for (const key of ['messages', 'recent']) {
    const start = arrayStartAfter(region, key)
    if (start < 0) continue
    for (const slice of sliceJsonObjects(region, start)) {
      const entry = parseEntry(slice)
      if (!entry || typeof entry !== 'object') continue
      if (typeof entry.text !== 'string') continue
      ;(key === 'messages' ? messages : recent).push(entry)
    }
  }
  return { messages, recent, raw: region }
}

/** 把 tool/call 的 arguments 变成消息文本数组。 */
export function outgoingTexts(argumentsValue) {
  let parsed = argumentsValue
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed)
    } catch {
      return { texts: [], key: null }
    }
  }
  if (!parsed || typeof parsed !== 'object') return { texts: [], key: null }
  const raw = parsed.messages ?? parsed.message
  let texts = []
  if (typeof raw === 'string') texts = [raw]
  else if (Array.isArray(raw)) texts = raw.filter((x) => typeof x === 'string' && x.trim())
  return { texts, key: typeof parsed.key === 'string' ? parsed.key : null }
}

function hhmmToMs(at, baseMs) {
  // at 可能是 "22:40" 或 "10-23 23:19"
  if (typeof at !== 'string') return null
  const m = /^(?:(\d{2})-(\d{2})\s+)?(\d{1,2}):(\d{2})$/.exec(at.trim())
  if (!m) return null
  const base = new Date(baseMs)
  const month = m[1] ? Number(m[1]) : base.getMonth() + 1
  const day = m[2] ? Number(m[2]) : base.getDate()
  const d = new Date(baseMs)
  d.setMonth(month - 1, day)
  d.setHours(Number(m[3]), Number(m[4]), 0, 0)
  // 如果算出来比基准时间晚很多（跨天回看），往回拨一天
  if (d.getTime() - baseMs > 6 * 3600_000) d.setDate(d.getDate() - 1)
  return d.getTime()
}

/**
 * 事件流 → 聊天条目。
 * @returns {{lines: Array<{time:number,side:'in'|'out',name:string,text:string,key:string|null}>, stats: object}}
 */
export function extractChat(events, opts = {}) {
  const botName = opts.botName ? String(opts.botName) : BOT_NAME
  const lines = []
  const stats = { userMessages: 0, snapshots: 0, sendCalls: 0, rawIn: 0, rawOut: 0, dropped: 0 }

  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue
    const time = Number.isFinite(ev.time) ? ev.time : null

    // ── 进来的：user/message 里的快照 ────────────────────────────────
    if (ev.type === 'user/message') {
      const kind = ev?.data?.source?.kind ?? 'user'
      if (kind !== 'user') continue
      stats.userMessages += 1
      const parts = Array.isArray(ev.data?.content) ? ev.data.content : []
      const body = parts.filter((p) => p?.type === 'text').map((p) => p.text).join('\n')
      const snap = extractSnapshot(body)
      if (!snap) continue
      stats.snapshots += 1

      for (const m of snap.messages) {
        if (m.isSelf === true) continue
        const text = typeof m.text === 'string' ? m.text.trim() : ''
        if (!text) continue
        stats.rawIn += 1
        const ts = hhmmToMs(m.at, time ?? Date.now()) ?? time
        lines.push({
          time: ts ?? 0,
          side: 'in',
          name: m.sender || (m.userId ? `QQ ${m.userId}` : '对方'),
          userId: m.userId ?? null,
          messageId: m.messageId ?? null,
          text,
          key: null,
          via: 'snapshot',
        })
      }
      // recent 里 isSelf 的是机器人自己说过的（补那些没留下 tool 调用的）
      for (const m of snap.recent) {
        if (m.isSelf !== true) continue
        const text = typeof m.text === 'string' ? m.text.trim() : ''
        if (!text) continue
        stats.rawOut += 1
        const ts = hhmmToMs(m.at, time ?? Date.now()) ?? time
        lines.push({
          time: ts ?? 0,
          side: 'out',
          name: botName,
          userId: null,
          messageId: m.messageId ?? null,
          text,
          key: null,
          via: 'snapshot-recent',
        })
      }
      continue
    }

    // ── 出去的：发消息的工具调用 ────────────────────────────────────
    if (ev.type === 'tool/call' && QQ_SEND_TOOLS.has(ev?.data?.name)) {
      stats.sendCalls += 1
      const { texts, key } = outgoingTexts(ev?.data?.arguments)
      for (const text of texts) {
        const trimmed = String(text).trim()
        if (!trimmed) continue
        stats.rawOut += 1
        lines.push({
          time: time ?? 0,
          side: 'out',
          name: botName,
          userId: null,
          messageId: null,
          text: trimmed,
          key,
          via: 'tool',
        })
      }
    }
  }

  // ── 排序 + 去重 ───────────────────────────────────────────────────
  lines.sort((a, b) => (a.time || 0) - (b.time || 0))
  const seenIds = new Set()
  const seenText = new Map() // side|text → time
  const out = []
  for (const line of lines) {
    if (line.messageId) {
      if (seenIds.has(line.messageId)) { stats.dropped += 1; continue }
      seenIds.add(line.messageId)
    }
    const k = `${line.side}|${line.text}`
    const prev = seenText.get(k)
    if (prev !== undefined && Math.abs(prev - line.time) < 12 * 3600_000) {
      stats.dropped += 1
      continue
    }
    seenText.set(k, line.time)
    out.push(line)
  }
  stats.lines = out.length
  return { lines: out, stats }
}

export function pad(n) {
  return String(n).padStart(2, '0')
}

export function dayKey(ms) {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function hhmm(ms) {
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * 一批聊天条目 → Markdown 行（跨天时自动插入 `## YYYY-MM-DD` 分隔）。
 * lastDay 传上一次写到哪一天，避免续写时重复插分隔线。
 */
export function renderChatDelta(lines, lastDay = '', opts = {}) {
  const botName = opts.botName ? String(opts.botName) : BOT_NAME
  const out = []
  let currentDay = lastDay || ''
  for (const line of lines) {
    const dk = dayKey(line.time)
    if (dk !== currentDay) {
      currentDay = dk
      out.push(`## ${dk}`)
      out.push('')
    }
    const who = line.side === 'out' ? `**${botName}**` : `**${line.name}**`
    const text = line.text.replace(/\r?\n/g, ' ⏎ ')
    out.push(`- \`${hhmm(line.time)}\` ${who}：${text}`)
  }
  return out.join('\n')
}

/**
 * 聊天条目 → 干净的 Markdown（只含双方对话）。
 */
export function renderChatMarkdown({ lines, meta = {}, botName: bn }) {
  const botName = bn ? String(bn) : BOT_NAME
  const out = []
  out.push(`# 💬 QQ 聊天记录 · ${meta.title || '(未命名会话)'}`)
  out.push('')
  const inCount = lines.filter((l) => l.side === 'in').length
  const outCount = lines.length - inCount
  if (lines.length) {
    out.push(`> 时间范围：${dayKey(lines[0].time)} ${hhmm(lines[0].time)} → ${dayKey(lines[lines.length - 1].time)} ${hhmm(lines[lines.length - 1].time)}`)
  }
  out.push(`> 共 ${lines.length} 条（对方 ${inCount} · ${botName} ${outCount}）`)
  if (meta.sessionId) out.push(`> 会话 ID：\`${meta.sessionId}\``)
  if (meta.cwd) out.push(`> 工作目录：\`${meta.cwd}\``)
  if (meta.peer) out.push(`> 聊天对象：${meta.peer}`)
  out.push('')
  out.push('---')
  out.push('')
  out.push(renderChatDelta(lines, ''))
  out.push('')
  return out.join('\n')
}
