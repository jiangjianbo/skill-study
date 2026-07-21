# subagent-hello Plugin — Project Guide

## 1. 项目概述

OpenCode 插件，在检测到**真正空闲（TRUE_IDLE）**后等待 1 分钟，然后通过**主 agent 调用 Task 工具**启动子代理。利用宿主（OpenCode Host）的原生能力自动创建子会话、渲染可点击链接、保存完整消息历史。

### 关键能力

| 能力 | 说明 |
|------|------|
| 空闲检测 | 复合状态机（status + permission + question）排除误判 |
| 延迟执行 | TRUE_IDLE 后 60s 定时器，用户输入自动取消 |
| Agent 驱动 | 向主会话注入 prompt，指示主 agent 调用 `Task` 工具 |
| 宿主接管 | 子会话创建、可点击链接渲染、消息持久化全部由宿主完成 |
| 可复用 | 子代理控制逻辑封装在 `SubagentTrigger` 类中，可独立复用 |

### 核心机制

插件**不直接创建子会话**。而是向主会话发送 prompt，主 agent 收到后调用内置 `Task(subagent_type='explore', ...)` 工具。宿主自动完成：

1. 创建子会话（`ses_xxx`）
2. 渲染 `<task id="ses_xxx" state="running">` → TUI 中显示为**可点击链接**
3. 子代理完成后注入合成消息 `<task state="completed">`
4. 保存子会话完整消息历史到 `~/.local/share/opencode/storage/`

用户点击链接即可切换到子会话视图，查看子代理的完整输出。

> 设计参考：`../swarm-subagent-screen.md` Pattern 1（agent 调用 Task 工具）

## 2. 架构与设计

### 流程

```
插件启动
  │
  ▼
OpenCodeTrueIdleDetector 监听事件
  │
  ├── session.status: idle ── 200ms 去抖 ── 检查 perm/quest 状态
  │                                  │
  │                                  ▼
  │                             TRUE_IDLE? ──yes──→ onIdle 回调
  │                                  │
  │                                 no
  │                                  ▼
  │                               SKIP
  │
  ▼
onIdle(sessionID)
  │
  ├── trigger.inFlight == true → SKIP
  └── trigger.inFlight == false
        └── setTimeout(60_000)
              └── trigger.trigger(sessionID, { agentType, prompt })
                    │
                    └── client.session.prompt(主会话, 指示文本)
                          │
                          ▼
                    主 agent 调用 Task(subagent_type='explore', ...)
                          │
                          ▼
                    ┌─── 宿主自动完成 ───────────────────┐
                    │  • 创建子会话 (ses_xxx)              │
                    │  • 渲染可点击 <task> 链接            │
                    │  • 保存消息历史到 storage/           │
                    │  • 子代理完成后注入合成消息          │
                    └─────────────────────────────────────┘
                          │
                          ▼
                    用户点击链接 → 切换到子会话视图
```

### 信号与事件映射

| Event Type | 对状态机的影响 | 消费方影响 |
|---|---|---|
| `session.status` (type=idle) | status=idle，触发去抖 | — |
| `session.status` (type=busy) | status=busy，取消去抖 | — |
| `session.idle` | 记录 activeSessionID | — |
| `permission.asked` | waitingPermission=true | — |
| `permission.replied` | waitingPermission=false，触发重检 | — |
| `question.asked` | waitingQuestion=true | — |
| `question.replied2/rejected2` | waitingQuestion=false，触发重检 | — |
| `chat.message` (role=user) | 重置状态机 | 取消 pending 定时器 |
| `chat.message` (role=assistant) | — | 日志记录 |

## 3. 与旧版（插件管理子会话）的关键差异

| 维度 | 旧版（插件管理） | 新版（agent 驱动 Task 工具） |
|------|---------------|---------------------------|
| 子会话创建 | 插件 `client.session.create()` | 宿主通过 Task 工具 |
| 可点击链接 | ❌ 无 | ✅ 宿主自动渲染 `<task>` 信封 |
| 输出保存 | 手动写 `.log/` 文件 | 宿主自动保存到 `~/.local/share/opencode/storage/` |
| 输出查看 | 读日志文件 | TUI 中点击链接切换到子会话视图 |
| 子会话生命周期 | 创建→删除（一次性） | 宿主管理，**持久保存** |
| 取消机制 | 用户输入自动取消 pending 定时 | 同左（不变） |
| 代码复杂度 | 高（create/prompt/delete/cleanup ~70 行） | 低（SubagentTrigger 封装，核心 ~30 行） |

## 4. SubagentTrigger 类详解

```typescript
// src/subagent-trigger.js — 可独立复用的子代理触发器

class SubagentTrigger {
  constructor({ client, log, directory })

  // 只读状态
  get inFlight: boolean   // 是否正在触发中（防重入）
  get count: number       // 累计触发次数

  // 核心方法
  async trigger(sessionID, {
    agentType: 'explore',     // 子代理类型
    prompt: 'Hello!',         // 子代理 prompt
    description?: string,     // Task 描述
  }): Promise<void>
}
```

### 工作原理

1. `trigger()` 向主会话发送 `session.prompt()`，内容为指示主 agent 调用 Task 工具的结构化文本
2. 主 agent 解析指令 → 调用 `Task(subagent_type='explore', prompt='...')`
3. 宿主创建子会话、渲染链接、保存消息
4. `session.prompt()` 阻塞等待 agent 完成（包括 Task 工具执行）
5. 返回后 `inFlight` 复位为 `false`

### 指示文本格式

```
[subagent-hello 自动触发]

请立即调用 Task 工具，使用以下参数：
- subagent_type: "explore"
- description: "subagent-hello #1"
- prompt: "Hello! 请简短地打个招呼并自我介绍一下。"

直接调用 Task 工具，不要添加任何额外评论或解释。
```

## 5. 文件职责

```
08-subagent-output/
│
├── src/
│   ├── index.js                          ← 插件入口。导出 { id, server }
│   │                                       组装 detector + trigger，管理 pendingTimer
│   ├── opencode-true-idle-detector.js    ← OpenCodeTrueIdleDetector 状态机
│   │                                       去抖确认真正空闲，无需 skipNextUserMessage
│   └── subagent-trigger.js               ← SubagentTrigger 类（可复用）
│                                           封装 Task 工具触发逻辑、状态管理、日志
│
├── scripts/
│   └── postinstall.js                     ← npm postinstall 部署脚本
│                                           复制 src/ → .opencode/plugins/subagent-hello/src/
│                                           更新 .opencode/opencode.json
│
├── package.json                           ← postinstall + @opencode-ai/plugin 依赖
│
├── clean.sh                               ← 卸载：删除 .opencode/plugins/subagent-hello/ + .log/
│
├── AGENTS.md                              ← 本文档
├── README.md                              ← 用户文档
├── .gitignore                             ← 忽略 .log/ 和 node_modules/
└── .opencode/
    ├── opencode.json                      ← 运行时配置（插件引用在此）
    └── plugins/subagent-hello/src/        ← 部署产物
```

## 6. 实现规范

### 插件入口 (`src/index.js`)

- **导出格式**: ESM 默认导出 `{ id: string, server: Plugin }`
- `server(input)` 接收 `PluginInput`，含 `{ directory, client, ... }`
- 返回 `{ event, "chat.message", dispose }` 三个 hook
- 组装 `OpenCodeTrueIdleDetector` + `SubagentTrigger`
- `pendingTimer` 管理 60s 延迟
- 可配置常量：`TRIGGER_DELAY_MS`、`SUBAGENT_AGENT_TYPE`、`SUBAGENT_PROMPT`

### SubagentTrigger 类 (`src/subagent-trigger.js`)

- JavaScript 私有字段（`#`）封装状态
- `inFlight` 标志防重入
- `count` 累计触发次数（用于 description 标识）
- `trigger()` 方法 async，内部 try/catch/finally 保证 `inFlight` 复位
- `#buildInstruction()` 生成结构化指示文本
- **可独立复用**：只需 `{ client, log, directory }` 即可实例化

### OpenCodeTrueIdleDetector 类 (`src/opencode-true-idle-detector.js`)

- JavaScript 私有字段（`#`）封装状态
- `scheduleCheck(sessionID, delay=200)` 用 `setTimeout` 去抖
- `onIdle` 回调解锁后同步调用（回调本身可 async）
- `handleEvent` 同步方法，仅操作状态机和定时器
- **无需 skipNextUserMessage**：新方案中主会话的 user message 自然触发状态重置，行为正确

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
| `TRUE_IDLE` | **去抖后确认真正空闲** |
| `SKIP` | 去抖后条件不满足 / trigger 正在运行 |
| `DEBOUNCE` | 去抖被 busy 取消 |
| `IDLE_END` | idle → busy 转换 / handleUserInput 时处于 idle |
| `RESET` | 状态机重置（用户输入触发） |
| `PERM` | permission.asked/replied |
| `QUEST` | question.asked/replied/rejected |
| `SCHEDULE` | trigger 已排期（60s 后触发） |
| `CANCEL` | 用户输入取消 pending 定时器 |
| `TRIGGER` | 开始触发（SubagentTrigger） |
| `TRIGGER_DONE` | session.prompt 完成，agent 已响应 |
| `TRIGGER_ERR` | 触发失败 |
| `INTERRUPT` | 用户中断（ESC / MessageAbortedError） |
| `USER_INPUT` | 用户消息 |
| `AI_REPLY` | AI 回复 |
| `DISPOSE` | 插件关闭 |

### 取消机制

- 用户输入（`chat.message` role=user）时：`clearTimeout` pending 定时器
- `trigger.inFlight` 标志防重入：正在运行时跳过的下一次 TRUE_IDLE
- 用户中断（ESC / MessageAbortedError）：取消 pending 定时器

## 7. 部署规范

### 安装

```bash
npm install
```

流程：
1. npm 安装 `@opencode-ai/plugin`
2. postinstall 自动运行：
   - 复制 `src/` → `.opencode/plugins/subagent-hello/src/`
   - 更新 `.opencode/opencode.json` 追加插件引用
3. **重启 opencode** 加载插件

检查日志：`tail -f .log/log-*.log`

### 卸载

```bash
bash clean.sh
```

## 8. 关键约束

1. **`subagent_type` 必须是 `explore`** — 不是 `explorer`，否则 Task 工具报错
2. **不允许使用外部 logger 模块** — createLogger 内联
3. **日志路径必须用 `directory` input** — 禁止 `__dirname`
4. **不允许存在 `install.sh`** — 通过 `npm install` + postinstall 部署
5. **所有源文件使用 ESM** — `"type": "module"` 在 package.json
6. **`chat.message` 文本截断 2000 字符**
7. **postinstall 必须是幂等的**
8. **子代理控制逻辑必须封装在 `SubagentTrigger` 类中** — 便于复用
9. **插件不直接创建/删除子会话** — 通过 agent 调用 Task 工具，由宿主管理生命周期
