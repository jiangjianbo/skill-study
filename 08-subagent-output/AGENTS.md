# subagent-hello Plugin — Project Guide

## 1. 项目概述

OpenCode 插件，在检测到**真正空闲（TRUE_IDLE）**后等待 1 分钟，然后启动一个独立的 subagent（子会话）执行简单任务。基于 `06-idle-prompt` 的 TrueIdleDetector 状态机，增加 subagent 会话生命周期管理。

### 关键能力

| 能力 | 说明 |
|------|------|
| 空闲检测 | 复合状态机（status + permission + question）排除误判 |
| 延迟执行 | TRUE_IDLE 后 60s 定时器，用户输入自动取消 |
| Subagent | 创建子会话，运行独立 `explorer` agent，等待返回 |
| 生命周期 | 自动清理：创建 → prompt → 读取输出 → 删除会话 |
| 输出方式 | 输出到项目日志文件（.log/）和服务器日志 |

### 设计限制

**插件 API 不支持将 subagent 输出直接显示到主 agent 界面**，因为：
- `client.session.messages.create` 方法不存在
- `$.transform.chat.messages` 方法不存在
- `client.app.log` 只写服务器日志，不显示在主 session

要实现 subagent 输出到主 agent 界面，需要使用 **agent 调用 Task 工具**的方式（参考 `../swarm-subagent.md` Pattern 1），而不是插件方式。

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
  ├── subagent.running == true → SKIP
  └── subagent.running == false
        └── setTimeout(60_000)
              └── launchSubagent(sessionID)
                    │
                    ├── client.session.create({ parentID, title })
                    ├── client.session.prompt({ agent: 'explorer', parts: 'Hello!...' })
                    ├── 提取输出 → 日志（.log/ + 服务器日志）
                    └── client.session.delete()
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
| `chat.message` (role=user) | — | 取消 pending 定时器 |
| `chat.message` (role=assistant) | — | 日志记录 |

## 3. 与 `06-idle-prompt` 的关键差异

 | 维度 | 06-idle-prompt | 08-subagent-output |
|------|---------------|-------------------|
| 空闲后行为 | 立即发送 "hello" 到当前 session | 等待 60s 后启动 subagent |
| 目标会话 | 当前主会话 | 独立子会话（parentID 关联） |
| 子会话 | 无 | `session.create()` → `session.prompt()` → `session.delete()` |
| Agent | 无（当前 session 默认 agent） | 指定 `explorer` agent |
| 取消机制 | 无 | 用户输入自动取消 pending 定时 |
| 输出方式 | 直接输出到当前 session | 输出到日志文件（.log/ + 服务器日志） |

## 4. Subagent 模式详解

```typescript
// 1. 创建独立子会话
const createResult = await client.session.create({
  body: { parentID: mainSessionID, title: 'subagent-hello-1' },
  query: { directory },
});
const subSessionId = createResult.data.id;

// 2. 发送 prompt — 阻塞等待完成
const promptResult = await client.session.prompt({
  path: { id: subSessionId },
  body: {
    agent: 'explorer',
    tools: { write: false, edit: false, patch: false },
    parts: [{ type: 'text', text: 'Hello! ...' }],
  },
});

// 3. 读取输出
const output = promptResult.data.parts
  .filter(p => p.type === 'text')
  .map(p => p.text).join('\n');

// 4. 输出到日志
await client.app.log({ body: { message: `[Subagent] ${output}` } });

// 5. 清理
await client.session.delete({ path: { id: subSessionId } });
```

### 上下文隔离

| 维度 | 隔离机制 |
|------|----------|
| **LLM 上下文** | `session.create()` → 独立 UUID → 独立消息历史 |
| **工具权限** | 显式禁止写工具（write/edit/patch=false） |
| **Agent 类型** | 指定 `explorer`（只读 agent） |
| **生命周期** | `parentID` 仅用于 TUI 展示，不共享上下文 |

## 5. 文件职责

```
08-subagent-output/
│
├── src/
│   ├── index.js                          ← 插件唯一入口。导出 { id, server }
│   │                                       内置 createLogger、launchSubagent
│   └── opencode-true-idle-detector.js    ← OpenCodeTrueIdleDetector 类
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
- `input.client` 用于调用 `session.create()` / `session.prompt()` / `session.delete()`

### OpenCodeTrueIdleDetector 类 (`src/opencode-true-idle-detector.js`)

- JavaScript 私有字段（`#`）封装状态
- `scheduleCheck(sessionID, delay=200)` 用 `setTimeout` 去抖
- `onIdle` 回调解锁后同步调用（回调本身可 async）
- `handleEvent` 同步方法，仅操作状态机和定时器

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
| `SKIP` | 去抖后条件不满足 / subagent 正在运行 |
| `DEBOUNCE` | 去抖被 busy 取消 |
| `PERM` | permission.asked/replied |
| `QUEST` | question.asked/replied/rejected |
| `SCHEDULE` | subagent 已排期（60s 后启动） |
| `CANCEL` | 用户输入取消 pending 定时器 |
| `SUBAGENT` | 开始启动 subagent |
| `SUBAGENT_CREATED` | 子会话创建成功 |
| `SUBAGENT_DONE` | subagent prompt 完成 |
| `SUBAGENT_ERR` | subagent 失败 |
| `SUBAGENT_CLEANUP` | 子会话已删除 |
| `USER_INPUT` | 用户消息 |
| `AI_REPLY` | AI 回复 |
| `DISPOSE` | 插件关闭 |

### 取消机制

- 用户输入（`chat.message` role=user）时：`clearTimeout` pending 定时器
- `subagent.running` 标志防重入：正在运行时跳过的下一次 TRUE_IDLE

### Subagent 生命周期保证

- `session.create()` 和 `session.delete()` 成对出现
- `delete()` 在 `finally` 语义后 `.catch(() => {})` 确保不抛异常
- 使用 `explorer` agent 并显式禁止所有写工具
- `parentID` 链接到主会话仅用于 TUI 展示，不共享上下文

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

1. **不允许使用外部 logger 模块** — createLogger 内联
2. **日志路径必须用 `directory` input** — 禁止 `__dirname`
3. **不允许存在 `install.sh`** — 通过 `npm install` + postinstall 部署
4. **所有源文件使用 ESM** — `"type": "module"` 在 package.json
5. **`chat.message` 文本截断 2000 字符**
6. **postinstall 必须是幂等的**
7. **Subagent 生命周期：create 和 delete 必须成对**
8. **写入工具必须显式禁用（write/edit/patch=false）**
