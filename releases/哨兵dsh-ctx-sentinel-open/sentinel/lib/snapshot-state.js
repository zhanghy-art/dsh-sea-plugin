/**
 * 「随身状态包」——打包**原始状态**而不是对话摘要。
 *
 * 为什么不用摘要：摘要会丢掉「我是谁、跟谁什么关系、在等什么」这类底色。
 * 所以这里直接抄原始数据，让新接手的实例读完能自报家门，而不是背一段简介。
 *
 * 打包四样东西：
 *   1. 角色卡（persona layers.json，决定怎么说话）
 *   2. persona state（情绪、对每个人的亲近/信任和 note）
 *   3. longmem 里属于 ownerScope 的记忆条目（+ global）
 *   4. 日记 + 还没寄出去的信
 *
 * 设计要点：
 *   - **边走边写**：每次轮询都读这四样，和上次比有变化就立刻更新文件，不等阈值。
 *   - **一对话一份**：文件名带会话短 id，同一对话永远只写同一个文件。
 *   - **增量续写**：首次写全量，之后只追加新增/变化的部分，绝不重写已有内容。
 *   - **实时块**：文件开头有一段原地刷新的「现在」，让文件时间戳始终是新鲜的。
 *   - 长期记忆按 tier 分三段渲染（核心/用户/随心情），让分层策略在包里看得见。
 *
 * 所有路径与称呼都从配置来（见 resolveCfg），代码里不留任何硬编码。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import path from 'node:path'

/**
 * 默认值。全部可在 sentinel-target.json 的 `statePack` 段覆盖：
 *
 *   "statePack": {
 *     "botName": "助手",
 *     "ownerLabel": "用户",
 *     "ownerScope": "private:123456789",
 *     "baseDir": "C:/path/to/bot-extras",
 *     "sources": {
 *       "personaLayers": "…/persona/layers.json",
 *       "personaState":   "…/persona/state.json",
 *       "longmem":        "…/longmem/store.jsonl",
 *       "diary":          "…/diary/diary.jsonl",
 *       "letters":        "…/diary/letters.jsonl"
 *     }
 *   }
 *
 * 只给 baseDir 时，五个来源按下面的默认相对路径拼出来；
 * 想单独指路就显式写 sources 里对应的键（优先级高于 baseDir）。
 */
const DEFAULTS = {
  botName: 'AI',
  ownerLabel: '用户',
  ownerScope: '',
  baseDir: '',
  sources: {},
}

/** 五个状态来源的默认相对路径（相对 baseDir）。 */
const SOURCE_REL = {
  personaLayers: ['persona', 'layers.json'],
  personaState: ['persona', 'state.json'],
  longmem: ['longmem', 'store.jsonl'],
  diary: ['diary', 'diary.jsonl'],
  letters: ['diary', 'letters.jsonl'],
}

/** 把用户配置归一化成可直接用的形状（缺什么给什么默认值，绝不抛错）。 */
function resolveCfg(cfg) {
  const sp = (cfg && cfg.statePack) || {}
  const base = String(sp.baseDir || DEFAULTS.baseDir || '')
  const givenSources = sp.sources || {}
  const sources = {}
  for (const [key, rel] of Object.entries(SOURCE_REL)) {
    sources[key] = givenSources[key] ? String(givenSources[key]) : base ? path.join(base, ...rel) : ''
  }
  return {
    botName: String(sp.botName || DEFAULTS.botName),
    ownerLabel: String(sp.ownerLabel || DEFAULTS.ownerLabel),
    ownerScope: String(sp.ownerScope || DEFAULTS.ownerScope),
    sources,
  }
}

/** 记忆分层标签（与 longmem/engine.mjs 的 tierOf 保持一致；那边是真相源，这里只为渲染分组）。 */
const CORE_TAGS = ['核心', '约定', '身份', '里程碑', '边界']
const USER_TAGS = ['印象', '用户', '偏好']
const CORE_MIN_IMPORTANCE = 8

function tierOf(item) {
  const t = String(item?.tier ?? '').trim()
  if (t === 'core' || t === 'user' || t === 'ordinary') return t
  const tags = (item?.tags ?? []).map((x) => String(x))
  if (tags.some((x) => CORE_TAGS.includes(x))) return 'core'
  if (tags.some((x) => USER_TAGS.includes(x)) && String(item?.scope ?? '').startsWith('private:')) return 'user'
  if (Number(item?.importance) >= CORE_MIN_IMPORTANCE) return 'core'
  return 'ordinary'
}

function readJsonSafe(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** 宽松取数：非数字/NaN/空都退回 fallback。 */
function num(v, fallback = 0) {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

function readJsonlSafe(file) {
  if (!existsSync(file)) return []
  const out = []
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const s = line.trim()
    if (!s) continue
    try {
      out.push(JSON.parse(s))
    } catch {
      /* 坏行跳过 */
    }
  }
  return out
}

function isoLocal(ms) {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** 四样原始状态的最新值 + 一个总指纹（用于判断有没有变化）。 */
export function collectState(cfg) {
  const { sources } = resolveCfg(cfg)
  const parts = {}

  // 1) 角色卡（怎么说话）
  const layers = readJsonSafe(sources.personaLayers)
  parts.layers = layers

  // 2) persona state（情绪 + 关系）
  const state = readJsonSafe(sources.personaState)
  parts.state = state

  // 3) longmem 里属于 ownerScope 的那份（+ global）
  const { ownerScope } = resolveCfg(cfg)
  const mems = readJsonlSafe(sources.longmem).filter((m) => !m.scope || (ownerScope && m.scope === ownerScope) || m.scope === 'global')
  parts.longmem = mems

  // 4) 日记（最近 20 篇）+ 没寄出去的信（全部）
  const diaryAll = readJsonlSafe(sources.diary)
  parts.diary = diaryAll.slice(-20)
  parts.diaryTotal = diaryAll.length
  const lettersAll = readJsonlSafe(sources.letters)
  parts.lettersDraft = lettersAll.filter((l) => (l.status ?? 'draft') !== 'sent')
  parts.lettersTotal = lettersAll.length

  // 指纹：任何内容变了都算变（关系数值哪怕小数点后三位动了也算——那也是「它」）
  parts.fingerprint = JSON.stringify([layers, state, mems.map((m) => [m.id, m.text, m.importance, m.lastUsed, m.tier]), parts.diary, parts.lettersDraft])
  return parts
}

function moodText(state) {
  if (!state?.mood) return '（无记录）'
  const m = state.mood
  const has = m.label != null || m.valence != null || m.energy != null || (m.note != null && String(m.note).trim())
  if (!has) return '（无记录）'
  const bits = [m.label ?? '?', `valence ${m.valence ?? '?'}`, `energy ${m.energy ?? '?'}`]
  if (m.note) bits.push(`「${m.note}」`)
  return bits.join(' / ')
}

function relText(r) {
  if (!r) return '（无记录）'
  const bits = [`亲近 ${r.closeness ?? '?'}`, `信任 ${r.trust ?? '?'}`]
  // notes 是 [{text, at}]，focus 是 [{text, at, expiresAt}]——原文照抄，别让它们变成 [object Object]
  const notes = (r.notes ?? []).map((n) => (typeof n === 'string' ? n : `${n.text ?? ''}${n.at ? `（${isoLocal(n.at)}）` : ''}`)).filter(Boolean)
  if (notes.length) bits.push(`notes：${notes.join('；')}`)
  const t = r.lastInteractionAt ? isoLocal(r.lastInteractionAt) : '?'
  return `${bits.join('，')}（最近互动 ${t}）`
}

function focusText(focus) {
  return (focus ?? [])
    .map((f) => (typeof f === 'string' ? f : f.text ?? ''))
    .filter(Boolean)
    .join('；')
}

/** 一条记忆的一行原文（带层级前缀，让「只增不减」在包里头一眼可见）。 */
function memLine(m) {
  const imp = m.importance != null ? `（重要性 ${m.importance}）` : ''
  const tags = m.tags?.length ? ` [${m.tags.join('/')}]` : ''
  const tier = tierOf(m)
  const badge = tier === 'core' ? '🔒核心' : tier === 'user' ? '👤用户' : '🍃随心情'
  return `- ${badge} ${imp}${tags} ${m.text}`
}

/** 渲染成 Markdown——重点是原文照抄，不是摘要。 */
export function renderStateMarkdown(parts, { reason = '', cfg = null } = {}) {
  const { botName, ownerLabel, ownerScope } = resolveCfg(cfg)
  const now = isoLocal(Date.now())
  const out = []
  out.push(`# ${botName}的随身状态包（${now}）`)
  out.push('')
  out.push(`> 这不是聊天摘要，是${botName}此刻的原始状态。新的实例读完要能自己说出：我是谁、跟谁什么关系、在等什么。`)
  if (reason) out.push(`> 本次定格原因：${reason}`)
  out.push('')

  // 1) 我是谁、怎么说话
  out.push('## 1. 角色卡（layers.json 原文）')
  out.push('')
  if (parts.layers) {
    for (const [group, lines] of Object.entries(parts.layers)) {
      out.push(`### ${group}`)
      out.push('')
      for (const line of lines ?? []) out.push(`- ${line}`)
      out.push('')
    }
  } else {
    out.push('（读不到 layers.json——角色卡缺失，这份包不完整）')
    out.push('')
  }

  // 2) 此刻的状态
  out.push('## 2. persona state（此刻的情绪与关系，原文数值）')
  out.push('')
  const s = parts.state
  if (s) {
    out.push(`- 情绪：${moodText(s.mood)}`)
    out.push(`- 对用户：${relText(s.relationship?.master)}`)
    for (const other of s.relationship?.others ?? []) {
      out.push(`- 对 ${other.name ?? other.target ?? '?'}：${relText(other)}`)
    }
    if (focusText(s.focus)) out.push(`- 正在意的事：${focusText(s.focus)}`)
  } else {
    out.push('（读不到 state.json——状态缺失，这份包不完整）')
  }
  out.push('')

  // 3) longmem（按 tier 分三段：核心与用户只增不减，其余按需保留）
  const core = parts.longmem.filter((m) => tierOf(m) === 'core')
  const user = parts.longmem.filter((m) => tierOf(m) === 'user')
  const rest = parts.longmem.filter((m) => tierOf(m) === 'ordinary')
  out.push(`## 3. 长期记忆（longmem · ${ownerScope || '全部 scope'} + global，共 ${parts.longmem.length} 条，原文）`)
  out.push('')
  out.push(`> 分层：🔒核心 ${core.length} 条 + 👤用户 ${user.length} 条只增不减；🍃随心情 ${rest.length} 条按需保留。`)
  out.push('')
  out.push(`### 3.1 核心记忆（🔒 只增不减，${core.length} 条）`)
  out.push('')
  if (!core.length) out.push('（还没有核心记忆）')
  else for (const m of core) out.push(memLine(m))
  out.push('')
  out.push(`### 3.2 用户记忆（👤 对${ownerLabel}的印象与偏好，只增不减，${user.length} 条）`)
  out.push('')
  if (!user.length) out.push('（还没有用户记忆——多聊聊就有了）')
  else for (const m of user) out.push(memLine(m))
  out.push('')
  out.push(`### 3.3 随心情的记忆（🍃 可增可减，${rest.length} 条）`)
  out.push('')
  if (!rest.length) out.push('（空）')
  else for (const m of rest) out.push(memLine(m))
  out.push('')

  // 4) 日记 + 信
  out.push(`## 4. 日记（最近 ${parts.diary.length}/${parts.diaryTotal} 篇，原文）`)
  out.push('')
  if (!parts.diary.length) {
    out.push('（还没有日记）')
  } else {
    for (const d of parts.diary) {
      out.push(`### ${d.date ?? d.id}　${d.mood ? `[${d.mood}]` : ''}　${d.title ?? ''}`)
      out.push('')
      out.push(d.body ?? '（空）')
      out.push('')
    }
  }
  out.push(`## 5. 还没寄出去的信（${parts.lettersDraft.length} 封，原文）`)
  out.push('')
  if (!parts.lettersDraft.length) {
    out.push('（没有没寄出去的信——都寄出去了，或还没写过）')
  } else {
    for (const l of parts.lettersDraft) {
      out.push(`### 收信人：${l.to ?? '用户'}　${l.mood ? `[${l.mood}]` : ''}　${l.title ?? ''}`)
      out.push('')
      out.push(l.body ?? '（空）')
      out.push('')
    }
  }
  out.push('')
  out.push('---')
  out.push(`*状态包由上下文哨兵自动维护：平时边走边写，90% 兜底时定格。生成于 ${now}。*`)
  return out.join('\n')
}

/**
 * 「现在」区块的标记：这一块是**原地刷新**的，不追加。
 * 用户 2026-10-26 的要求：状态包要实时更新，但不能越写越厚。
 * 所以真正的实时性由这一块承担（时间、正在聊哪个对话、归档了多少条、用量），
 * 其余内容仍然是「只追加增量」。
 */
const LIVE_BEGIN = '<!-- live:begin -->'
const LIVE_END = '<!-- live:end -->'

function renderLiveBlock(live, now) {
  const out = [LIVE_BEGIN, '## 0. 现在（实时）', '']
  out.push(`- 最后刷新：${now}`)
  if (live?.title) out.push(`- 正在聊：${live.title}${live.sessionId ? `　\`${live.sessionId}\`` : ''}`)
  if (live?.chatLines != null) out.push(`- 这个对话已归档：${live.chatLines} 条`)
  if (live?.ratio != null) out.push(`- 上下文用量：${(live.ratio * 100).toFixed(1)}%`)
  if (live?.note) out.push(`- ${live.note}`)
  out.push('- 说明：这一段原地刷新；下面第 1-5 节是首次全量快照，之后的「状态更新」只追加新增/变化的部分。')
  out.push(LIVE_END)
  return out.join('\n')
}

/** 把「现在」区块替换成最新的（没有就插在标题段之后）。除这一块外一个字节都不动。 */
function upsertLiveBlock(text, live, now) {
  const block = renderLiveBlock(live, now)
  const b = text.indexOf(LIVE_BEGIN)
  const e = text.indexOf(LIVE_END)
  if (b !== -1 && e !== -1 && e > b) return text.slice(0, b) + block + text.slice(e + LIVE_END.length)
  const idx = text.indexOf('\n\n')
  if (idx === -1) return `${text}\n\n${block}\n`
  return `${text.slice(0, idx)}\n\n${block}${text.slice(idx)}`
}

/** 「现在」区块的完整签名：只有它变了才重写文件，避免每 15 秒无意义落盘。
 *  用量按**整数百分比**算——0.1% 的抖动不值得重写一次文件。
 *  另外带上**分钟桶**：这样「最后刷新」这个时间戳每分钟会更新一次，
 *  用户看文件就知道哨兵还活着、还在盯着这个对话（否则数字不动时会以为它又停了）。 */
function liveSigOf(live) {
  if (!live) return 'none'
  return JSON.stringify([
    live.title ?? null,
    live.sessionId ?? null,
    live.chatLines ?? null,
    live.ratio != null ? Math.round(live.ratio * 100) : null,
    live.note ?? null,
    Math.floor(Date.now() / 60_000),
  ])
}

/** 「重要」的那一半：换了对话、对话又归档了新条数。
 *  这部分一变必须立刻落盘，绝不节流——那才是用户真正要看的东西。 */
function liveCoreOf(live) {
  if (!live) return 'none'
  return JSON.stringify([live.title ?? null, live.sessionId ?? null, live.chatLines ?? null])
}

/** 只刷新「现在」区块时的最小间隔：30 秒。对话本身有新内容时不受此限，立刻写。 */
const LIVE_ONLY_MIN_MS = 30_000

/**
 * 水位文件名（记着已经写进状态包的内容，续写只写增量）。
 * 2026-10-28：水位要跟着**每个对话的状态包**各存一份，
 * 否则 A 对话写过的记忆会被当成「B 对话也已经写过」，B 的增量就漏了。
 */
function watermarkFile(dir, tag) {
  return path.join(dir, `.state-pack${tag ? `-${tag}` : ''}.watermark.json`)
}

function loadWatermark(dir, tag) {
  try {
    return JSON.parse(readFileSync(watermarkFile(dir, tag), 'utf8'))
  } catch {
    return null
  }
}

function saveWatermark(dir, wm, tag) {
  // 先写临时文件再 rename：原子落盘。原先直接覆盖写，进程被并发打断时会留下
  // 「头部完整、尾部截断」的半截 JSON（实测出现过一次），下次 loadWatermark 解析失败
  // 就当没水位，于是一路重放全量。rename 在 Windows 同目录下是原子的。
  const file = watermarkFile(dir, tag)
  const tmp = `${file}.tmp`
  try {
    writeFileSync(tmp, `${JSON.stringify(wm, null, 2)}\n`, 'utf8')
    renameSync(tmp, file)
  } catch {
    /* 水位写不出去也不致命——下次只是多写一点 */
  }
}

function diaryKey(d) {
  return d.id ?? d.date ?? `${d.title ?? ''}@${d.createdAt ?? ''}`
}

/** 情绪/关系/在意的事，任何一项动一下就算变。 */
function personaSig(state) {
  if (!state) return 'none'
  const m = state.mood ?? {}
  const master = state.relationship?.master ?? {}
  const others = (state.relationship?.others ?? []).map((o) => [o.name ?? o.target, o.closeness, o.trust, o.notes])
  return JSON.stringify([m.label, m.valence, m.energy, m.note, master.closeness, master.trust, master.notes, master.lastInteractionAt, others, state.focus])
}

function renderStateDelta(parts, delta, now) {
  const out = []
  out.push('')
  out.push('---')
  out.push('')
  out.push(`## 状态更新 @ ${now}`)
  out.push('')
  if (delta.personaChanged) {
    out.push('### 此刻的状态变了')
    out.push('')
    out.push(`- 情绪：${moodText(parts.state?.mood)}`)
    out.push(`- 对用户：${relText(parts.state?.relationship?.master)}`)
    for (const other of parts.state?.relationship?.others ?? []) {
      out.push(`- 对 ${other.name ?? other.target ?? '?'}：${relText(other)}`)
    }
    if (focusText(parts.state?.focus)) out.push(`- 正在意的事：${focusText(parts.state?.focus)}`)
    out.push('')
  }
  if (delta.newMem.length) {
    const nCore = delta.newMem.filter((m) => tierOf(m) === 'core').length
    const nUser = delta.newMem.filter((m) => tierOf(m) === 'user').length
    const nRest = delta.newMem.filter((m) => tierOf(m) === 'ordinary').length
    out.push(`### 新增长期记忆（${delta.newMem.length} 条：🔒核心 ${nCore} / 👤用户 ${nUser} / 🍃随心情 ${nRest}，原文）`)
    out.push('')
    for (const m of delta.newMem) out.push(memLine(m))
    out.push('')
  }
  if (delta.newDiary.length) {
    out.push(`### 新写日记（${delta.newDiary.length} 篇，原文）`)
    out.push('')
    for (const d of delta.newDiary) {
      out.push(`#### ${d.date ?? d.id}　${d.mood ? `[${d.mood}]` : ''}　${d.title ?? ''}`)
      out.push('')
      out.push(d.body ?? '（空）')
      out.push('')
    }
  }
  if (delta.newLetters.length) {
    out.push(`### 新写但还没寄出的信（${delta.newLetters.length} 封，原文）`)
    out.push('')
    for (const l of delta.newLetters) {
      out.push(`#### 收信人：${l.to ?? '用户'}　${l.mood ? `[${l.mood}]` : ''}　${l.title ?? ''}`)
      out.push('')
      out.push(l.body ?? '（空）')
      out.push('')
    }
  }
  out.push(`*更新于 ${now}。*`)
  return out.join('\n')
}

/**
 * 边走边写：状态有变化就更新 <deliverDir>/QQ聊天/state-pack.md。
 *
 * 「只生成一次 + 后续续写」：第一次写全量快照，之后每次只在文件末尾追加一段
 * `## 状态更新 @ 时间`，只含**新增/变化**的部分（按 id 去重的长期记忆、新写的日记
 * 与信、情绪/关系变化），绝不重写已有内容。水位记在 sidecar 里，重启也不丢。
 *
 * 2026-10-26 用户要求「要实时添加」：另外维护一个原地刷新的 `## 0. 现在（实时）`
 * 区块（live 参数：当前对话标题/会话 id/归档条数/用量），它变化时重写文件——
 * 但只替换那一段，第 1-5 节和所有历史「状态更新」一个字节都不动，
 * 所以文件不会越写越厚，也不会重复生成新文件。
 *
 * 2026-10-28 用户要求「每个工作区对话只开一次状态包」：文件名改成跟着会话走，
 * `state-pack-<sess8>.md`；原来那个不区分的 `state-pack.md` 会在第一次
 * 拿到 sessionId 时被这个对话的文件接管（见下面 legacyFile 迁移）。
 */
export function updateLiveStatePack(deliverDir, lastFingerprint, { reason = '', live = null, cfg = null } = {}) {
  const parts = collectState(cfg)
  const fingerprint = parts.fingerprint

  const dir = path.join(deliverDir, 'QQ聊天')
  // 每个对话一份状态包：身份用 session 短 id，和对话文件保持同一套规则。
  const tag = String(live?.sessionId ?? '').replace(/^session-/, '').slice(0, 8).replace(/[^\w-]/g, '')
  const file = path.join(dir, tag ? `state-pack-${tag}.md` : 'state-pack.md')
  // 老版本那个不区分对话的状态包；首次接管时把它的历史内容并进来，别丢。
  const legacyFile = path.join(dir, 'state-pack.md')
  const now = isoLocal(Date.now())
  const liveSig = liveSigOf(live)

  // 指纹没变、实时块也没变 → 真的什么都不用做
  if (fingerprint === lastFingerprint) {
    const wm0 = existsSync(file) ? loadWatermark(dir, tag) : null
    if (wm0 && wm0.liveSig === liveSig) return { changed: false, parts, fingerprint }
  }

  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    /* 目录已存在 */
  }

  // 文件不在了（被清理/首次生成）→ 重新写全量，水位清零
  let wm = existsSync(file) ? loadWatermark(dir, tag) : null

  // 迁移：这个对话还没有自己的状态包，但老的不区分对话的那份在 →
  // 直接把老的整份接过来（历史增量、live 块都在里面），然后改名归位。
  if (!wm && file !== legacyFile && existsSync(legacyFile)) {
    try {
      const legacyText = readFileSync(legacyFile, 'utf8')
      const legacyWm = loadWatermark(dir, null)
      writeFileSync(file, legacyText, 'utf8')
      if (legacyWm) saveWatermark(dir, legacyWm, tag)
      renameSync(legacyFile, path.join(dir, `.state-pack.md.migrated-${tag}`))
      const legacyWmPath = watermarkFile(dir, null)
      if (existsSync(legacyWmPath)) renameSync(legacyWmPath, `${legacyWmPath}.migrated-${tag}`)
      wm = loadWatermark(dir, tag)
    } catch {
      /* 迁移失败就按首次生成处理 */
    }
  }

  if (!wm) {
    const full = `${renderStateMarkdown(parts, { reason: reason || '初始化状态包' })}\n`
    writeFileSync(file, upsertLiveBlock(full, live, now), 'utf8')
    saveWatermark(dir, {
      memIds: parts.longmem.map((m) => m.id).filter(Boolean),
      diaryKeys: parts.diary.map(diaryKey),
      letterIds: parts.lettersDraft.map((l) => l.id ?? `${l.to ?? ''}@${l.title ?? ''}`),
      personaSig: personaSig(parts.state),
      liveSig,
      liveCore: liveCoreOf(live),
      liveUpdatedAt: Date.now(),
      updatedAt: Date.now(),
    }, tag)
    return { changed: true, parts, fingerprint, file, created: true }
  }

  const memIds = new Set(wm.memIds ?? [])
  const diaryKeys = new Set(wm.diaryKeys ?? [])
  const letterIds = new Set(wm.letterIds ?? [])
  const sig = personaSig(parts.state)

  const delta = {
    newMem: parts.longmem.filter((m) => m.id && !memIds.has(m.id)),
    newDiary: parts.diary.filter((d) => !diaryKeys.has(diaryKey(d))),
    newLetters: parts.lettersDraft.filter((l) => !letterIds.has(l.id ?? `${l.to ?? ''}@${l.title ?? ''}`)),
    personaChanged: sig !== wm.personaSig,
  }

  const anyDelta = delta.newMem.length || delta.newDiary.length || delta.newLetters.length || delta.personaChanged
  const liveChanged = wm.liveSig !== liveSig
  const liveCore = liveCoreOf(live)
  // 对话换了 / 归档条数涨了 —— 这是真内容，必须立刻写，永不节流
  const liveCoreChanged = wm.liveCore !== liveCore
  const nowMs = Date.now()
  if (!anyDelta && !liveChanged) {
    // 指纹变了但说不出变了什么（多半是取值方式变了）——只刷新水位，不写文件
    saveWatermark(dir, {
      memIds: parts.longmem.map((m) => m.id).filter(Boolean),
      diaryKeys: parts.diary.map(diaryKey),
      letterIds: parts.lettersDraft.map((l) => l.id ?? `${l.to ?? ''}@${l.title ?? ''}`),
      personaSig: sig,
      liveSig,
      liveCore,
      liveUpdatedAt: num(wm.liveUpdatedAt, 0),
      updatedAt: nowMs,
    }, tag)
    return { changed: false, parts, fingerprint, file }
  }

  // 只有「现在」区块要变、而且只是用量/时间戳在抖、离上次刷新还不到 30 秒 → 缓一缓。
  // 但对话换了或归档条数涨了（liveCoreChanged）时不受节流限制，立刻写。
  if (!anyDelta && liveChanged && !liveCoreChanged && nowMs - num(wm.liveUpdatedAt, 0) < LIVE_ONLY_MIN_MS) {
    return { changed: false, parts, fingerprint, file, throttled: true }
  }

  let text = readFileSync(file, 'utf8')
  if (anyDelta) text += `${renderStateDelta(parts, delta, now)}\n`
  if (liveChanged) text = upsertLiveBlock(text, live, now)
  writeFileSync(file, text, 'utf8')
  saveWatermark(dir, {
    memIds: parts.longmem.map((m) => m.id).filter(Boolean),
    diaryKeys: parts.diary.map(diaryKey),
    letterIds: parts.lettersDraft.map((l) => l.id ?? `${l.to ?? ''}@${l.title ?? ''}`),
    personaSig: sig,
    liveSig,
    liveCore,
    liveUpdatedAt: liveChanged ? nowMs : num(wm.liveUpdatedAt, 0),
    updatedAt: nowMs,
  }, tag)
  return { changed: true, parts, fingerprint, file, delta, liveOnly: !anyDelta }
}

/**
 * 90% 兜底：定格一份「这个对话」的状态副本。
 *
 * 2026-10-26 用户要求：**不开新对话就不加新文件**。
 * 原来的做法是每次触发都写一个带时间戳的新文件（实测一次会话里堆了 6 份，
 * 内容几乎一样，纯属噪音）。现在改成：
 *   - 一个对话只认一个定格文件，名字带会话 id 前 8 位：`state-pack-<session>.md`；
 *   - 同一个对话再次触发 90%，**原地覆盖**这一份，绝不新增第二个；
 *   - 只有真的换了对话（新 session id）才会出现新文件。
 * 想留历史版本请另存，这里不再自动堆副本。
 */
export function snapshotStatePack(groupDir, stampStr, { reason = '', sessionId = '', cfg = null } = {}) {
  const parts = collectState(cfg)
  const md = renderStateMarkdown(parts, { reason: reason || '90% 兜底定格', cfg })
  const tag = String(sessionId || '').replace(/^session-/, '').slice(0, 8) || '未知会话'
  const file = path.join(groupDir, `state-pack-${tag}.md`)
  const existed = existsSync(file)
  const body = `${md}\n\n---\n\n*最后一次兜底定格：${stampStr}（同一个对话只留这一份，覆盖更新）*\n`
  writeFileSync(file, body, 'utf8')
  return { file, parts, overwritten: existed }
}
