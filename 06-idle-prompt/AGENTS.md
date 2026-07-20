# idle-prompt Plugin — Project Guide

## 1. Project Overview

OpenCode 插件，在检测到 **真正空闲（True Idle）** 时自动向大模型发送指令 `hello`，并确保前一次回复处理完成之后才能发送下一次。基于 `05-idle-check-plugin` 的 ExecutionTracker 状态机，增加自动 prompt 与重复检查机制。

### 关键能力

| 能力 | 说明 |
|------|------|
| 空闲检测 | 复合状态机（status + permission + question）排除误判 |
| 自动指令 | TRUE_IDLE 时发送 "hello" 到当前 session |
| 重复检查 | `helloLocked` 标志位：发送后锁定，`client.session.prompt()` 返回后解锁，才能发下一次 |

## 2. 架构与设计

### 状态机

```
ExecutionTracker {
  status: 'idle' | 'busy'        ← session.status
  waitingPermission: boolean     ← permission.asked/replied
  waitingQuestion: boolean       ← question.asked/replied2/rejected2
  helloLocked: boolean           ← true: 已发送 hello 等待回复完成
  helloCount: number             ← 累计发送次数
  activeSessionID: string|null   ← 当前活跃 session
  pendingCheck: timeout|null     ← 200ms 去抖定时器
}
```

### 判定逻辑

```
TRUE_IDLE (200ms debounce after status=idle + !perm + !quest)
  ├── helloLocked == true → SKIP（等待回复中）
  └── helloLocked == false → sendHello() → helloLocked = true
                                └── client.session.prompt() 返回 → helloLocked = false
```

### 重复检查机制

```
helloLocked = true  ── 发送 hello 后立即锁定
        │
        ▼
session 变为 busy ── AI 开始处理 hello
        │
        ▼
client.session.prompt() 返回 ── AI 回复完成 → helloLocked = false
        │
        ▼
TRUE_IDLE 再次触发 ── 发送下一次 hello（循环）
```

`client.session.prompt()` 是阻塞式调用，等待 AI 完整回复（含工具调用）后才 resolve，天然作为"回复处理完成"的信号。用户输入时也会重置 `helloLocked` 和 `helloCount`。

### 信号与事件映射

| Event Type | 影响 |
|---|---|
| `session.status` (type=idle) | 设 status=idle，触发去抖检查 |
| `session.status` (type=busy) | 设 status=busy，取消 pending 去抖 |
| `session.idle` | 记录 activeSessionID |
| `permission.asked` | waitingPermission=true |
| `permission.replied` | waitingPermission=false，触发重检 |
| `question.asked` | waitingQuestion=true |
| `question.replied2` / `question.rejected2` | waitingQuestion=false，触发重检 |
| `chat.message` (role=user) | 重置 helloLocked=false, helloCount=0 |
| `chat.message` (role=assistant) | 日志记录（解锁由 prompt() 返回处理） |

## 3. 文件职责

```
06-idle-prompt/
│
├── src/
│   └── index.js                  ← 插件唯一入口。导出 { id, server }
│                                    内置 createLogger、ExecutionTracker、sendHello
│
├── scripts/
│   └── postinstall.js             ← npm postinstall 部署脚本
│                                    复制 src/ → .opencode/plugins/idle-prompt/src/
│                                    更新 .opencode/opencode.json
│
├── package.json                   ← postinstall + @opencode-ai/plugin 依赖
│
├── clean.sh                       ← 卸载：删除 .opencode/plugins/idle-prompt/ + .log/
│
├── AGENTS.md                      ← 本文档
├── README.md                      ← 用户文档
├── .gitignore                     ← 忽略 .log/ 和 node_modules/
└── .opencode/                     ← 运行时配置（opencode-swarm.json）
```

## 4. 实现规范

### 插件入口 (`src/index.js`)

- **导出格式**: ESM 默认导出 `{ id: string, server: Plugin }`
- `server(input)` 接收 `PluginInput`，含 `{ directory, client, ... }`
- 返回 `{ event, "chat.message", dispose }` 三个 hook
- `input.client` 用于调用 `session.prompt()` 发送指令

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
| `SKIP` | 去抖后条件不满足 |
| `DEBOUNCE` | 去抖被 busy 取消 |
| `PERM` | permission.asked/replied |
| `QUEST` | question.asked/replied/rejected |
| `HELLO` | 发送 hello |
| `HELLO_DONE` | hello 回复完成 |
| `HELLO_ERR` | hello 发送失败 |
| `USER_INPUT` | 用户消息 |
| `AI_REPLY` | AI 回复 |
| `DISPOSE` | 插件关闭 |

### 发送机制

- 使用 `client.session.prompt()`（阻塞式）：发送后等待完整 AI 回复（含工具调用）才继续
- 天然保证"回复处理完成"后才解锁 `helloLocked`
- `sendHello()` 内部 `try/catch` 确保异常时解锁

### 去抖机制

- `scheduleCheck(sessionID, delay=200)` 用 `setTimeout` 实现
- 已有 pending 则 `clearTimeout` 重置
- 到期后验证 `status === 'idle' && !waitingPermission && !waitingQuestion`
- 若中途变为 busy，立即取消

## 5. 部署规范

### 安装

```bash
npm install
```

流程：
1. npm 安装 `@opencode-ai/plugin`
2. postinstall 自动运行：
   - 复制 `src/index.js` → `.opencode/plugins/idle-prompt/src/index.js`
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
