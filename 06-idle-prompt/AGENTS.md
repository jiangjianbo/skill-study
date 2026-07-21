# idle-prompt Plugin — Project Guide

## 1. Project Overview

OpenCode 插件，在检测到 **真正空闲（True Idle）** 时自动向大模型发送指令 `hello`，并确保前一次回复处理完成之后才能发送下一次。基于 `05-idle-check-plugin` 的 ExecutionTracker 状态机，增加自动 prompt 与重复检查机制。

### 关键能力

| 能力 | 说明 |
|------|------|
| 空闲检测 | 复合状态机（status + permission + question）排除误判 |
| 自动指令 | TRUE_IDLE 时发送 "hello" 到当前 session |
| 重复检查 | `helloLocked` 标志位：发送后锁定，`client.session.prompt()` 返回后解锁，才能发下一次 |
| 指数退避 | TRUE_IDLE 持续检测，每次翻倍间隔（200ms → 400ms → 800ms...），用户输入后重置 |

## 2. 架构与设计

### 完整状态流转图

```
                      ┌───────────────────────────────────────────────┐
                      │           IDLE (status=idle)                   │
                      │   perm=false, quest=false, interrupt=false     │
                      └──────────────────┬────────────────────────────┘
                                         │
                             session.status(type=idle)
                             (且 !perm && !quest)
                                         │
                                         ▼
                            ┌───────────────────────┐
                            │     CANDIDATE          │
                            │ scheduleCheck(sid, d)  │
                            │ pendingCheck≠null      │
                            └───────────┬───────────┘
                                        │
              ┌─────────────────────────┼────────────────────────────┐
              │                         │                            │
        session.status              setTimeout                  session.status
        (type=busy)                  到期                      (type=idle, 重入)
              │                         │                            │
              ▼                         ▼                            ▼
     ┌────────────────┐      ┌─────────────────────┐         回到 CANDIDATE
     │   DEBOUNCE     │      │     TRUE_IDLE        │         (新 pending)
     │  清除 pending   │      │   onIdle() 回调       │
     │  status=busy   │      │   currentDelay *= 2  │
     └────────────────┘      │   递归 scheduleCheck  │
              │              └──────────┬──────────┘
              │                         │
              │             ┌───────────┴───────────┐
              │             │                       │
              │        ESC 中断                 用户输入
              │     (MessageAbortedError)   (chat.message user)
              │             │                       │
              │             ▼                       ▼
              │    ┌──────────────────┐   ┌───────────────────┐
              │    │   INTERRUPTED    │   │  handleUserInput  │
              │    │  interrupt=true  │   │  interrupt=false  │
              │    │  跳过所有 idle   │   │  status=busy      │
              │    └──────────────────┘   │  delay 重置 200   │
              │             │             └────────┬──────────┘
              │             │                      │
              │             │               若 status 之前为 idle
              │             │               → onIdleExit()
              │             │                      │
              │             ▼                      ▼
              │     (等待用户手动输入)        (等待下次 idle 事件)
              │             │
              └─────────────┼────────────────────────────┘
                            │
                    用户输入重置
                    interrupt=false
                    status=busy
                    delay=200
                            │
                            ▼
                   (等待 session.status idle)
```

### OpenCodeTrueIdleDetector 类

`OpenCodeTrueIdleDetector` 位于 `src/opencode-true-idle-detector.js`，是一个可复用的空闲检测器，封装了 ExecutionTracker 状态机 + 200ms 基础去抖 + 指数退避持续检测。

```
OpenCodeTrueIdleDetector {
  #BASE_DELAY: 200                    ← 基础延迟（ms）
  #currentDelay: number               ← 当前退避延迟，TRUE_IDLE 后翻倍
  #status: 'idle' | 'busy'           ← session.status
  #waitingPermission: boolean         ← permission.asked/replied
  #waitingQuestion: boolean           ← question.asked/replied2/rejected2
  #activeSessionID: string|null       ← 当前活跃 session
  #idleSince: number|null             ← 最近一次 session.idle 时间戳
  #pendingCheck: timeout|null         ← setTimeout 句柄
  #onIdle: (sessionID) => void        ← TRUE_IDLE 回调（异步通知）
}
```

#### 构造函数

```js
new OpenCodeTrueIdleDetector({ log, onIdle, onIdleExit, onUserInterrupt, onUserInput })
```

| 参数 | 类型 | 说明 |
|------|------|------|
| `log` | `(level, msg) => void` | 日志输出函数 |
| `onIdle` | `async (sessionID) => void` | TRUE_IDLE 触发的异步回调 |
| `onIdleExit` | `(sessionID) => void` | **退出 idle 状态时触发**（idle→busy / 用户输入重置 / 中断） |
| `onUserInterrupt` | `(sessionID) => void` | **用户 ESC 中断时触发**（MessageAbortedError） |
| `onUserInput` | `(sessionID) => void` | **用户手动输入消息时触发**（排除插件自身 prompt） |

#### 公开方法

| 方法 | 签名 | 说明 |
|------|------|------|
| `handleEvent` | `({ event }) => void` | 处理 `session.status` / `session.idle` / `permission.*` / `question.*` |
| `handleChatMessage` | `(input, output) => void` | 处理 `chat.message`，检测 ESC 中断（MessageAbortedError）和用户手动输入 |
| `handleUserInput` | `(sessionID) => void` | 用户输入时重置状态（clear pending、reset flags、busy、reset delay）；若当前 idle 则触发 `onIdleExit` |
| `setPromptInFlight` | `(v: boolean) => void` | 标记插件自身 prompt 进行中，避免误判为用户输入 |
| `dispose` | `() => void` | 清理 pending 定时器 |
| `activeSessionID` | (getter) | 当前活跃 session ID |
| `interrupted` | (getter) | 当前是否处于用户中断状态（ESC 后 true，下次用户输入前一直阻塞） |

### 持续检测与指数退避

- 首次 `session.status(idle)` 触发 `scheduleCheck(sid)`，延时 `currentDelay`（初始 200ms）
- TRUE_IDLE 确认后：调用 `onIdle(sessionID)` + `currentDelay *= 2` + **递归 reschedule**（持续检测）
- `permission.replied` / `question.replied2|rejected2` 触发重检时传入显式 200ms，重置退避
- 用户输入时 `handleUserInput` 重置 `currentDelay = BASE_DELAY`

### ESC 中断机制

当用户双击 ESC 中断 AI 回复时：
1. `chat.message` 在 `role === 'assistant'` 中携带 `MessageAbortedError`
2. `handleChatMessage` 检测到该错误，设置 `#interrupted = true`
3. 同样支持 `session.cancel` 事件作为中断检测路径
4. `#interrupted = true` 期间，`scheduleCheck` 跳过所有 idle 触发，**不再发出 hello**
5. 用户手动输入消息时（`role === 'user'` 且 `!promptInFlight`），`handleChatMessage` 自动调用 `handleUserInput` 重置 `#interrupted = false`，恢复 idle 检测
6. ESC 中断时（中断时 session 可能为 busy），`onIdleExit` **不触发**（idle→busy 过渡才触发）；仅当用户在 idle 状态下手动输入时，`handleUserInput` 触发 `onIdleExit`

### 重复检查机制（由消费方实现）

`OpenCodeTrueIdleDetector` 不关心业务锁逻辑，通过 `onIdle` 回调通知消费方。消费方自行管理 `helloLocked`：

```
onIdle(sessionID)
  ├── helloLocked == true → SKIP（等待回复中）
  └── helloLocked == false → sendHello() → helloLocked = true
                                └── client.session.prompt() 返回 → helloLocked = false
```

```
helloLocked = true  ── 发送 hello 后立即锁定
        │
        ▼
client.session.prompt() 等待 AI 完整回复（含工具调用）
        │
        ▼
prompt() 返回 ── AI 回复完成 → helloLocked = false
        │
        ▼
下一次 TRUE_IDLE 检查（持续检测 + 退避）─→ onIdle → 发送下一个 hello（循环）
```

`client.session.prompt()` 是阻塞式调用，天然保证"回复处理完成"后才解锁。用户输入时同时重置 `helloLocked`、`helloCount` 和 detector 内部状态。

### 信号与事件映射

| Event Type | OpenCodeTrueIdleDetector 内部影响 | 消费方影响 |
|---|---|---|
| `session.status` (type=idle) | `#status=idle`，触发去抖检查 | — |
| `session.status` (type=busy) | `#status=busy`，取消 pending 去抖 | — |
| `session.idle` | 记录 `#activeSessionID`、`#idleSince` | — |
| `permission.asked` | `#waitingPermission=true` | — |
| `permission.replied` | `#waitingPermission=false`，触发重检（200ms） | — |
| `question.asked` | `#waitingQuestion=true` | — |
| `question.replied2` / `question.rejected2` | `#waitingQuestion=false`，触发重检（200ms） | — |
| `chat.message` (role=user, !promptInFlight) | `handleUserInput()`: 重置全部状态 + `#interrupted=false`；若 `#status==='idle'` 则 **`onIdleExit`** | `onUserInput` 回调 → 重置 helloLocked=false, helloCount=0 |
| `chat.message` (role=assistant, MessageAbortedError) | `#interrupted=true` | `onUserInterrupt` 回调 → 重置 helloLocked=false, helloCount=0 |
| `session.status` (type=busy, 前值 idle) | `#status=busy` + **`onIdleExit`** | — |
| `session.cancel` | `handleUserInput()`: 重置全部状态 | 重置 helloLocked=false, helloCount=0 |

## 3. 文件职责

```
06-idle-prompt/
│
├── src/
│   ├── index.js                          ← 插件唯一入口。导出 { id, server }
│   │                                       内置 createLogger、sendHello
│   └── opencode-true-idle-detector.js    ← OpenCodeTrueIdleDetector 类
│
├── scripts/
│   └── postinstall.js                     ← npm postinstall 部署脚本
│                                           复制 src/ → .opencode/plugins/idle-prompt/src/
│                                           更新 .opencode/opencode.json
│
├── package.json                           ← postinstall + @opencode-ai/plugin 依赖
│
├── clean.sh                               ← 卸载：删除 .opencode/plugins/idle-prompt/ + .log/
│
├── AGENTS.md                              ← 本文档
├── README.md                              ← 用户文档
├── .gitignore                             ← 忽略 .log/ 和 node_modules/
└── .opencode/                             ← 运行时配置（opencode-swarm.json）
```

## 4. 实现规范

### 插件入口 (`src/index.js`)

- **导出格式**: ESM 默认导出 `{ id: string, server: Plugin }`
- `server(input)` 接收 `PluginInput`，含 `{ directory, client, ... }`
- 返回 `{ event, "chat.message", dispose }` 三个 hook
- `input.client` 用于调用 `session.prompt()` 发送指令

### OpenCodeTrueIdleDetector 类规范 (`src/opencode-true-idle-detector.js`)

- 使用 JavaScript 私有字段（`#`）封装状态，防止外部篡改
- `scheduleCheck` 用 `setTimeout` 实现去抖 + 指数退避
- `onIdle` 回调在去抖确认后**同步**调用，但回调本身可以是 `async`
- `handleEvent` 是**同步方法**，仅操作状态机和定时器，不处理回调结果
- `handleChatMessage` 负责检测 ESC 中断（MessageAbortedError）和用户手动输入
  - ESC 中断：设 `#interrupted = true` + 调用 `onUserInterrupt`
  - 用户输入：调用 `handleUserInput`（重置 `#interrupted`）+ 调用 `onUserInput`
- `handleUserInput` 重置 detector 全部内部状态（pending、interrupted、waiting flags、status、delay）；若当前 `#status==='idle'` 则触发 `onIdleExit`
- `handleEvent` 中 `session.status` 从 idle→busy 时也触发 `onIdleExit`
- `dispose` 清理 pending 定时器

### Logger

- 日志路径: `path.join(directory, '.log')` → 项目根目录 `.log/`
- 使用 `directory` input 参数，禁止使用 `__dirname`
- 格式: `[<ISO8601>] [<LEVEL>] <msg>`

### 日志级别

| Level | 触发时机 |
|---|---|
| `INIT` | 插件初始化 |
| `DESIGN` | 启动时输出设计决策 |
| `STATUS` | session.status 变更 |
| `IDLE` | session.idle 事件 |
| `CANDIDATE` | 进入 idle 但尚未去抖确认 |
| `IDLE_END` | **退出 idle 状态**（idle→busy / 用户输入重置） |
| `TRUE_IDLE` | **去抖后确认真正空闲** |
| `SKIP` | 去抖后条件不满足 |
| `DEBOUNCE` | 去抖被 busy 取消 |
| `PERM` | permission.asked/replied |
| `QUEST` | question.asked/replied/rejected |
| `HELLO` | 发送 hello |
| `HELLO_DONE` | hello 回复完成 |
| `HELLO_ERR` | hello 发送失败 |
| `USER_INPUT` | 用户消息 |
| `AI_REPLY` | AI 回复 |
| `INTERRUPT` | 用户 ESC 中断（MessageAbortedError / session.cancel） |
| `RESET` | 用户输入导致 detector 状态重置 |
| `DISPOSE` | 插件关闭 |

### 发送机制

- 使用 `client.session.prompt()`（阻塞式）：发送后等待完整 AI 回复（含工具调用）才继续
- 天然保证"回复处理完成"后才解锁 `helloLocked`
- `sendHello()` 内部 `try/catch` 确保异常时解锁

### 去抖与持续检测机制

- `scheduleCheck(sessionID, delay?)` 用 `setTimeout` 实现
- 已有 pending 则 `clearTimeout` 重置
- 到期后验证 `status === 'idle' && !waitingPermission && !waitingQuestion`
- TRUE_IDLE 时：调用 `onIdle` + `currentDelay *= 2` + 递归 `scheduleCheck`（持续检测）
- SKIP 时：`pendingCheck = null`，等待下一次事件触发
- 若中途变为 busy，立即取消 pending
- `permission.replied` / `question.replied2|rejected2` 触发重检时传入 200ms（重置退避）
- 用户输入时 `handleUserInput` 重置 `currentDelay` 为 `BASE_DELAY`

## 5. 部署规范

### 安装

```bash
npm install
```

流程：
1. npm 安装 `@opencode-ai/plugin`
2. postinstall 自动运行：
   - 复制 `src/index.js` + `src/opencode-true-idle-detector.js` → `.opencode/plugins/idle-prompt/src/`
   - 更新 `.opencode/opencode.json` 追加插件引用
3. **重启 opencode** 加载插件

检查日志：`tail -f .log/log-*.log`

### 卸载

```bash
bash clean.sh
```

## 6. 关键约束

1. **不允许使用外部 logger 模块** — createLogger 内联
2. **日志路径必须用 `directory` input** — 禁止 `__dirname`
3. **不允许存在 `install.sh`** — 通过 `npm install` + postinstall 部署
4. **所有源文件使用 ESM** — `"type": "module"` 在 package.json
5. **`chat.message` 文本截断 2000 字符**
6. **postinstall 必须是幂等的**
7. **`client.session.prompt()` 阻塞等待完整回复** — 这是"回复处理完成"的判定依据
