# DSH 上下文哨兵（dsh-ctx-sentinel）

> 让长对话在撞上上下文上限之前，先把「说过什么」和「我是谁」落到磁盘上。

## 它在解决什么问题

DSH 的会话有输入长度上限（通常是 100 万 token 量级）。一个聊得很久的会话会撞上去，然后：

- 模型侧直接返回 `400 Range of input length should be [1, 1000000]`
- 这一轮什么都跑不动，消息既没被处理也没被记住
- 前端看到的只是「出错了」，聊天记录停在原地

更麻烦的是**交接**：真到撑不住必须换会话时，新会话是个白纸——它不知道之前聊了什么，不知道对面是谁，不知道答应了什么还没做。

这个哨兵做两件事：

1. **归档**：会话接近上限时，把完整对话转写成 Markdown 落到磁盘（可读、可搜索、可离线留存）
2. **状态包**：持续维护一份「原始状态」文件（角色设定 / 情绪与关系 / 长期记忆 / 日记 / 未发出的信），让接手的新实例读完能自报家门

## 四条设计原则

这套东西改过很多轮，最后收敛成四条。想改它之前先读懂这四条，能省掉大部分返工。

### 一、一个对话只开一个文件

文件名里带**会话 id 前 8 位**，不带标题作为身份。标题会变（聊着聊着改个名），id 不会。

```
<分组名>-<标题>-<会话id前8位>.md
```

标题只是给人看的，随时可以变；定位靠 id。所以同一对话改名之后，文件还是那一个，继续往后写。

落地时还多一层保险：`findExistingChatFile()` 每次先扫目录，只要已经存在同 id 的文件就复用——哪怕历史原因拆出过好几份，也挑行数最多的那份当主文件，而不是再开一个新的。

### 二、只追加，不重写

归档文件一旦写出，**已有内容一个字节都不再改**。后续每次只把「上次水位之后的新消息」追加到末尾。

水位（watermark）记录 `{ids[], lastTime, lastDay}` 三个东西并存盘。它保证：

- 重复轮询不会把同一条消息写两遍
- 进程重启后接着上次的位置继续，不重不漏
- 文件只会变长，不会变短，也不会被某个后到的写者覆盖

这条原则的代价是文件不美观（增量段落是按批次的），但换来的是**数据永不丢失**。

### 三、阈值决定「何时同步」，不决定「是否停止」

早期版本里，用量到了阈值就调 `freezeSession()` 把会话标成 frozen，之后不再导出、不再续写。

**这个设计是错的**，已经删掉。原因：

- 阈值（比如 90%）不是会话的死亡点，压缩机制会先动手
- 提前冻结唯一的效果是——对话还在继续，但归档停了，档案从此不完整
- 真正撑不住的表现是模型返回 400，那个信号比百分比准确得多

所以现在阈值只做一件事：**到了就同步一份进长期记忆库**。归档和续写该干嘛干嘛，一直到会话真的跑不动为止。

### 四、状态包是原始状态，不是对话摘要

摘要会丢掉底色：语气、关系、还没做完的事、答应了谁什么。

所以状态包直接抄原始数据：

| 来源 | 内容 |
|---|---|
| `persona/layers.json` | 角色卡：身份、边界、说话风格 |
| `persona/state.json` | 情绪数值、对每个人的亲近/信任、note |
| `longmem/store.jsonl` | 长期记忆条目（按 ownerScope 过滤 + global） |
| `diary/diary.jsonl` | 最近 20 篇日记 |
| `diary/letters.jsonl` | 还没寄出去的信 |

全部路径可配（见下文「状态包配置」），代码里没有硬编码。

---

## 快速开始

### 环境要求

- Node.js 22.15+ 或 24+（需要 `zlib.zstdDecompressSync`，用来读 `.jsonl.zstd` 会话日志）
- 目前只在 Windows 上跑过（用到了进程表探活、Windows 通知、`detached` 后台进程）

### 安装

1. 把本目录放到 DSH 的插件目录下（插件系统通过 `cordis.patch.yml` 注入）：

```
<DSH 插件目录>/dsh-ctx-sentinel/
├── cordis.patch.yml
├── package.json
├── lib/index.js              ← 插件入口，负责拉起后台哨兵进程
├── sentinel/
│   ├── ctx-sentinel.js       ← 哨兵本体
│   └── lib/
│       ├── qq-chat.js        ← 从会话日志里抽对话
│       ├── session-format.js ← 读 .jsonl.zstd 会话
│       ├── snapshot-state.js ← 状态包
│       └── vault-sync.js     ← 写进记忆库
├── bin/
│   ├── boot-sentinel.ps1     ← 启动（幂等 + 清理重复实例）
│   ├── run-sentinel.cmd
│   └── sentinel.cmd
└── config.example.json
```

2. 复制配置：

```bash
cp config.example.json ~/.dsh/sentinel-target.json
```

3. 改 `sentinel-target.json`：至少把 `deliverDir` 指到一个真实目录，把 `statePack.ownerScope` 和 `statePack.baseDir` 填上（不用状态包可以不填）。

4. 重启 DSH。插件会在启动时检查哨兵是否在跑，不在就拉起来（`detached`，DSH 关掉它也继续跑）。

### 手动操作

```bash
node sentinel/ctx-sentinel.js --status      # 看状态：在不在跑、盯谁、投递到哪、有几份归档
node sentinel/ctx-sentinel.js --once        # 立即跑一轮（不等轮询）
node sentinel/ctx-sentinel.js --export-now  # 立即导出当前会话
```

---

## 文件命名规则

| 文件 | 命名 | 说明 |
|---|---|---|
| 分组对话 | `<分组名>-<标题>-<会话id前8位>.md` | 一个对话一份，改名不换文件 |
| 分组对话（旧版同目录遗留多份时） | 自动挑行数最多的当主文件 | 其余需人工归档 |
| 状态包 | `state-pack-<会话id前8位>.md` | 一个对话一份 |
| 状态包（无会话 id 时兜底） | `state-pack.md` | 极少出现 |
| 状态包水位 | `.state-pack-<会话id前8位>.watermark.json` | 隐藏文件，记账用 |
| 索引 | `索引.md` | 该目录所有归档的目录 |
| 导出日志 | `导出记录.log` | 追加型，记每次导出的时间/会话/用量 |

同目录下还可能有 `.state-pack.md.migrated-<id>`——那是从旧的全局状态包迁移时留下的归档，可以删。

---

## 配置

完整示例见 `config.example.json`。常用项：

### 全局

| 键 | 默认 | 说明 |
|---|---|---|
| `sessionId` | `auto` | `auto` = 盯当前最活跃的会话；也可填死某个 id |
| `threshold` | `0.98` | 全局导出阈值 |
| `pollMs` | `15000` | 轮询间隔（毫秒） |
| `deliverDir` | — | 归档根目录 |
| `scanAll` | `true` | `true` 盯所有会话；`false` 只盯最近有消息的 |
| `reExportDelta` | `0.01` | 已导出过的会话，用量再涨这么多才重新导出 |
| `minReExportMs` | `1800000` | 两次重新导出之间的最小间隔（30 分钟） |
| `nearWarn` | `[0.9, 0.95]` | 接近阈值时的提醒点 |

### 分组

`groups[]` 里的每一项匹配一类会话（按 workspace / cwd / title / sessionId），命中后走自己的目录和策略。

| 键 | 说明 |
|---|---|
| `dir` | 相对 `deliverDir` 的子目录，或绝对路径 |
| `threshold` | 覆盖全局阈值 |
| `chatOnly` | `true` = 只导出对话，丢掉工具调用/思考/系统提示词 |
| `toMemory` | `true` = 归档同时同步一份进长期记忆库 |
| `statePack` | `true` = 维护随身状态包 |
| `keepEvery` | `true` = 每次导出都留一份，永不覆盖 |

### 状态包配置（`statePack` 段）

只有分组开了 `statePack: true` 才会用到。

| 键 | 默认 | 说明 |
|---|---|---|
| `botName` | `AI` | 机器人自己的显示名，出现在对话记录与状态包标题 |
| `ownerLabel` | `用户` | 对「对面那个人」的称呼 |
| `ownerScope` | — | 记忆库里属于用户本人的 scope，如 `private:123456789` |
| `baseDir` | — | 五个状态源的根目录，给了它就不用逐个写 `sources` |
| `sources` | `{}` | 逐个指定五个来源文件；优先级高于 `baseDir` |

只给 `baseDir` 时，默认按这些相对路径找：

```
persona/layers.json
persona/state.json
longmem/store.jsonl
diary/diary.jsonl
diary/letters.jsonl
```

---

## 状态包长什么样

```markdown
<!-- live:begin -->
## 0. 现在（实时）

- 最后刷新：2026-01-01T12:34:56
- 正在聊：<标题> `session-abcd1234-...`
- 这个对话已归档：72 条
- 上下文用量：13.9%
<!-- live:end -->

## 1. 角色卡（layers.json 原文）
### identity / ### boundaries / ### style

## 2. persona state
（情绪数值 + 对每个人的亲近/信任 + note）

## 3. 长期记忆（按 tier 分组）
### 3.1 核心（只增不减）
### 3.2 用户（只增不减）
### 3.3 随心情

## 4. 日记（最近 20 篇）

## 5. 还没寄出去的信

## 状态更新 @ 2026-01-01T12:34:56
（第 N 次增量：新增了什么、变了什么）
## 状态更新 @ ...
```

### 实时块与节流

文件开头 `<!-- live:begin -->` 到 `<!-- live:end -->` 之间那一段是**原地替换**的：每次轮询只重写这一段，下面的历史内容与增量一字不动。

节流分两层，避免文件被无意义地反复重写：

| 什么变了 | 怎么做 |
|---|---|
| 对话条数变了（`chatLines`） | **立刻写**，不节流 |
| 只是用量百分比抖动 | 最少间隔 30 秒才写一次 |

判断依据是两个指纹：`liveCoreOf()` 只看「标题 / 会话 id / 归档条数」，`liveSigOf()` 再加上用量百分比和分钟桶。

### 增量怎么记

首次写全量（上面第 1～5 节）。之后每次轮询：

- 角色卡 / 情绪 / 关系变了 → 追加一段「状态更新」
- 长期记忆有新条目 → 只追加新条目，老的不动
- 有新日记、新写的信 → 追加对应的「新增」
- 什么都没变 → 只刷实时块，文件不增厚

水位文件（`.state-pack-<id>.watermark.json`）记着 `memIds[] / diaryKeys[] / letterIds[] / personaSig / updatedAt`，是这套增量逻辑的记账本。它用「临时文件 + rename」原子写入，避免并发打断留下半截 JSON。

---

## 工作流程

```
插件层（lib/index.js）
  └─ DSH 启动 → 扫进程表清理重复实例 → 检查哨兵是否在跑 → 不在就 detached 拉起
     └─ 看门狗每 5 分钟确认一次（崩了补拉）

哨兵层（sentinel/ctx-sentinel.js）
  └─ 每 pollMs 轮询一次
     ├─ 读会话的 contextPressure（用量、标题、项目目录）
     ├─ 命中分组 → 更新该对话的归档文件（增量追加 + 水位）
     ├─ 过了阈值 → 额外同步一份进长期记忆库
     └─ 分组开了 statePack → 刷新状态包（增量 + 实时块）
```

所有状态存在 `~/.dsh/sentinel-state.json`，进程重启后接着上次的水位继续。

---

## 常见坑

这些是实打实踩过的，写下来省点时间。

### 1. 多个哨兵实例（启动期会自动清理）

pidfile 只能记住一个 pid。历史上留过别的 pidfile、或者手动起过一次，就会有多个实例同时跑——它们轮流写同一份状态文件，于是「改了配置、杀了进程，状态却被另一个旧代码的实例打回去」。

**症状**：日志里同一个会话反复出现「已冻结」→「已解冻」；状态改完过一会儿又变回去。

**已经处理掉了**：启动器（`bin/boot-sentinel.ps1`）和插件入口（`lib/index.js`）都改成**以进程表为准**——扫所有命令行含 `ctx-sentinel.js` 的 node 进程，多于一个就保留启动最早的那个、其余强制结束，并把 pidfile 修正过去。pidfile 只在「它指的那个 pid 确实活着」时被采信，否则一律重新扫表。

**仍然可能踩到的情况**：只跑了启动器、DSH 插件却处于禁用状态，而启动器是旧版本（没有清理逻辑）。这时手动处理：

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*ctx-sentinel.js*' } |
  Select-Object ProcessId, CreationDate, CommandLine
# 确认后只留一个，其余 Stop-Process -Id <pid> -Force
```

### 2. 状态包被两个写入方覆盖

`snapshotStatePack()` 用 `writeFileSync` 整文件覆盖，`updateLiveStatePack()` 是增量追加。两个都跑就会互相踩：一个刚追加的增量，被另一个的全量覆盖掉。

**现在 `snapshotStatePack` 已经零调用**（保留函数是为了兼容旧配置），状态包统一只由 `updateLiveStatePack` 写。加新逻辑时别再调那个函数，也别直接 `writeFileSync` 状态包。

### 3. 状态包「不更新了」

如果状态包文件时间戳停住，先查指纹逻辑：早期版本只在**源文件内容变了**才写，而源文件的 mtime 可能一整天不变（那五个源本来就不是每轮都动）。现在的做法是实时块由 `live` 参数驱动，跟源文件解耦，只要对话在动，文件就在动。

### 4. 标题变了就多一个文件

已经修了（用会话 id 当身份）。但如果你的目录里还留着历史拆分出来的多份，`findExistingChatFile` 会挑行数最多的那份并打一条 warn 日志，其余的**需要人工归档**——它不会自己删，因为删数据比多一个文件危险。

### 5. 阈值别设太早

不要把 `threshold` 当成「该停了」的信号。它只决定什么时候多同步一份进记忆库。设成 0.5 也不会让对话更安全，只会让记忆库变乱。

### 6. 会话日志读不出来

会话是 `.jsonl.zstd`，需要支持 zstd 的 Node。如果哨兵日志里报解压失败，先确认 `node -e "console.log(typeof require('zlib').zstdDecompressSync)"` 输出 `function`。Node 22.15 之前没有这个 API。

---

## 目录结构（本仓库）

```
.
├── README.md
├── LICENSE
├── package.json
├── config.example.json
├── cordis.patch.yml
├── lib/
│   └── index.js              插件入口（拉起 + 看门狗）
├── sentinel/
│   ├── ctx-sentinel.js       哨兵本体
│   └── lib/
│       ├── session-format.js 读会话日志
│       ├── qq-chat.js        抽对话、渲染 Markdown
│       ├── snapshot-state.js 状态包（增量 + 实时块 + 水位）
│       └── vault-sync.js     写进记忆库
└── bin/
    ├── boot-sentinel.ps1
    ├── run-sentinel.cmd
    └── sentinel.cmd
```

## 许可

MIT。