# idle-check Plugin — Project Guide

## 1. Project Overview

OpenCode 插件，检测 AI **真正空闲**（True Idle）的时机。核心原理是维护一个复合状态机 `ExecutionTracker`，综合 session 状态、权限询问、问题询问三个维度，排除"看似空闲实则中间步骤停顿"的误判。

### 关键指标

| Signal | 误报率 |
|--------|--------|
| `session.idle` | ~10x/action（频繁误报）|
| `session.status=idle` | 同上 |
| `permission.asked` 期间 status 仍为 `busy` | 遗漏 |
| **ExecutionTracker（本项目）** | 近乎 0 |

## 2. 架构与设计

### 状态机 ExecutionTracker

```
ExecutionTracker {
  status: 'idle' | 'busy'        ← 来自 session.status
  waitingPermission: boolean     ← 来自 permission.asked/replied
  waitingQuestion: boolean       ← 来自 question.asked/replied2/rejected2
  idleSince: number | null       ← 上次 session.idle 时间戳
  pendingCheck: timeout | null   ← 去抖定时器（延时取决于 currentDelay）
  currentDelay: number           ← 当前检测延时，200ms 起步有退避
}
```

### 判定逻辑

```
chat.message (role=user)
  └── resetIdleState()
        ├── clearTimeout(pendingCheck)
        ├── status = 'busy'
        ├── waitingPermission = false
        ├── waitingQuestion = false
        └── currentDelay = BASE_DELAY (200ms)

session.status → idle
  ├── waitingPermission == true → NOT idle
  ├── waitingQuestion == true   → NOT idle
  └── 两者均为 false → 启动 currentDelay 去抖
                        ├── 期间收到 busy → 取消
                        └── 到期无变化 → TRUE_IDLE ✓
                              ├── currentDelay *= 2 (上限 30s)
                              └── 循环：再次调度下一轮 currentDelay 检查

用户长时间空闲时，TRUE_IDLE 会按递增间隔周期性持续触发，直到用户再次输入或 session 变 busy 为止。

每次用户输入 → 重置所有状态 + 退避计时器归零（startId=200ms）。
每次 TRUE_IDLE → 当前延时翻倍（200ms→400ms→800ms→...，无上限）。

### 信号与事件映射

| Event Type | 对状态机的影响 |
|---|---|
| `session.status` (type=idle) | 设 status=idle，触发去抖检查（使用 currentDelay） |
| `session.status` (type=busy) | 设 status=busy，取消 pending 去抖 |
| `session.idle` | 记录 idleSince 时间戳（辅助信息） |
| `permission.asked` | waitingPermission=true |
| `permission.replied` | waitingPermission=false，触发重检（200ms 固定） |
| `question.asked` | waitingQuestion=true |
| `question.replied2` | waitingQuestion=false，触发重检（200ms 固定） |
| `question.rejected2` | waitingQuestion=false，触发重检（200ms 固定） |
| `chat.message` (role=user) | **resetIdleState()** — 清空所有标志、取消 pending、status=busy、currentDelay 归零 |
| `chat.message` (role=assistant) | 仅记录 AI_REPLY 日志，不影响状态机 |

## 3. 文件职责

```
05-idle-check-plugin/
│
├── src/
│   └── index.js                  ← 插件唯一入口。导出 { id, server }
│                                    内置 createLogger（无需外部 logger 模块）
│
├── scripts/
│   └── postinstall.js             ← npm postinstall 部署脚本
│                                    复制 src/ → .opencode/plugins/idle-check/src/
│                                    更新 .opencode/opencode.json 添加插件引用
│
├── package.json                   ← 声明 postinstall 脚本 + @opencode-ai/plugin 依赖
│
├── clean.sh                       ← 清理：删除 .opencode/plugins/idle-check/ + .log/
│                                    可选重置 .opencode/opencode.json
│
├── AGENTS.md                      ← 本文档
├── README.md                      ← 用户文档
├── .gitignore                     ← 忽略 .log/ 和 node_modules/
└── .opencode/                     ← 部署产物（自动生成，不手动修改）
    ├── opencode.json              ← 插件引用在此
    └── plugins/idle-check/src/
        └── index.js               ← 部署后的插件副本
```

## 4. 实现规范

### 插件入口 (`src/index.js`)

- **导出格式**: ESM 默认导出 `{ id: string, server: Plugin }`
- `server(input)` 接收 `PluginInput`，其中 `input.directory` 是**项目根目录**
- 返回 `{ event, "chat.message", dispose }` 三个 hook

### Logger（内置，无外部模块）

```js
function createLogger(logDir) {
  // 日志路径: <logDir>/log-<YYYYMMDD-HHmmss>.log
  // 返回 (level, msg) => appendFileSync
}
```

- 日志目录：`path.join(directory, '.log')` → **项目根目录的 `.log/`**
- 必须使用 `directory` input 参数，**禁止使用 `__dirname`**（否则日志会写在 `.opencode/plugins/` 下而非项目根）
- 单行格式：`[<ISO8601>] [<LEVEL>] <msg>`
- 每次初始化创建一个新文件（时间戳命名）

### 日志级别（Level）

| Level | 触发时机 |
|---|---|
| `INIT` | 插件初始化 |
| `DESIGN` | 启动时输出设计决策（JSON） |
| `STATUS` | session.status 变更 |
| `IDLE` | session.idle 事件 |
| `CANDIDATE` | 进入 idle 但尚未去抖确认 |
| `TRUE_IDLE` | **去抖后确认真正空闲** |
| `SKIP` | 去抖后发现条件不满足 |
| `DEBOUNCE` | 去抖被 busy 取消 |
| `PERM` | permission.asked/replied |
| `QUEST` | question.asked/replied/rejected |
| `RESET` | 用户输入触发 resetIdleState() |
| `USER_INPUT` | 用户消息（通过 chat.message hook） |
| `AI_REPLY` | AI 回复（通过 chat.message hook） |
| `DISPOSE` | 插件关闭 |

### Event Hook 规范

- `event({ event })` 处理通用事件，根据 `event.type` 分发
- 从 `event.properties` 中提取 `sessionID`：优先级 `properties.sessionID > properties.info?.id > '-'`
- 每个分支结束后必须 `break`
- `"chat.message"` hook 接收 `(input, output)`：
  - `input`: `{ sessionID, messageID, model? }`
  - `output`: `{ message: { role }, parts: [{ text }] }`
  - 通过 `message.role` 区分 user/assistant
  - 文本从 `parts[].text` 拼接，截断至 2000 字符

### 去抖与退避机制

- `scheduleCheck(sessionID, delay)` 用 `setTimeout` 实现
- 不传 delay 时使用 `currentDelay`（随历史 idle 循环递增）
- 已有 pending 则 `clearTimeout` 重置
- 到期后检查 `status === 'idle' && !waitingPermission && !waitingQuestion`
- 若中途变为 busy，立即取消
- TRUE_IDLE 触发后 `currentDelay *= 2`（无上限）
- TRUE_IDLE 触发后**自动调度下一轮检查**（使用递增后的 currentDelay），形成周期性链
- 用户输入（`chat.message` role=user）触发 `resetIdleState()`：
  - 取消 pending check（切断链）
  - 清空 waitingPermission/waitingQuestion
  - status = 'busy'
  - currentDelay 归零至 BASE_DELAY（200ms）

## 5. 部署规范

### 安装（用户操作）

```bash
npm install
```

流程：
1. npm 安装 `@opencode-ai/plugin` 依赖
2. postinstall 自动运行 `node scripts/postinstall.js`：
   - 复制 `src/index.js` → `.opencode/plugins/idle-check/src/index.js`
   - 更新 `.opencode/opencode.json` 追加 `"./plugins/idle-check/src/index.js"` 到 `plugin[]`
3. 重启 opencode 加载插件

### 卸载

```bash
bash clean.sh
```

删除 `.opencode/plugins/idle-check/` 和 `.log/`，可选重置配置文件。

### postinstall.js 规范

- 使用 `import.meta.url` 而非 `__dirname`（ESM 环境）
- 幂等：opencode.json 中已存在插件引用时不重复追加
- 读取失败时回退到空对象

## 6. 关键约束

1. **不允许使用外部 logger 模块** — createLogger 内联在 index.js 中
2. **日志路径必须用 `directory` input** — 禁止 `__dirname`（04-simple-plugin 的已知 bug）
3. **不允许存在 `install.sh`** — 部署通过 `npm install` + postinstall 完成
4. **`.opencode/` 目录由自动部署工具写入** — 手动修改违反配置规则
5. **所有源文件使用 ESM** — `"type": "module"` 在 package.json
6. **`chat.message` 文本截断 2000 字符** — 防止日志文件过大
7. **postinstall 必须是幂等的** — 重复 `npm install` 不应产生副作用
