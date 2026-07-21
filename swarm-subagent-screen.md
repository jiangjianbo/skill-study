# 子代理(Subagent)输出查看机制分析

## 核心结论

**open code-swarm 本身不创建可点击链接，也不实现屏幕切换逻辑。** 这些能力来自 OpenCode 宿主(Host)的上游内置功能。opencode-swarm 作为 **Server Plugin**（非 TUI Plugin），没有 UI 渲染 API，它的角色仅限于：解析信封、持久化记录、注册工具/代理。

---

## 1. 主 agent 输出中可点击链接的生成机制

### 上游：OpenCode 宿主的 `<task>` 信封渲染

当 architect 调用内置的 `Task` 工具时，OpenCode 宿主（非插件代码）会生成一个 XML 风格的信封：

```
<task id="ses_07ae807cffeyTxSU0oHuGezLb" state="running">
<summary>...</summary>
<task_result>...</task_result>
</task>
```

OpenCode 的 TUI/GUI 宿主 **自动识别** `<task id="ses_..." state="...">` 标签，并将 `sessionID` 渲染为**可点击的链接**。用户点击后，UI 切换到该子代理的会话屏幕查看其完整输出。这是宿主内置行为，plugins 无需也不可干预。

### 插件侧：解析信封（只读）

opencode-swarm 在 `src/background/task-envelope.ts:36-76` 定义了正则解析器：

```typescript
const TASK_ENVELOPE_RE =
  /<task\s+id="([^"]+)"\s+state="(running|completed|error)"\s*>/;
```

`parseTaskEnvelope()`（第 44 行）从文本中提取 `sessionId`、`state`、`summary`、`resultText`。`extractDispatchIds()`（第 112 行）从 `tool.execute.after` 的输出对象中提取子代理 session ID。

### 插件侧：delegation-gate 记录分发

`src/hooks/delegation-gate.ts:1637-1712` 在每次子代理分发的 `toolAfter` 钩子中：

1. 调用 `extractDispatchIds(_output)`（第 1654 行）提取 `subagentSessionId`
2. 调用 `recordPendingDelegation(...)`（第 1671 行）记录到 `.swarm/background-delegations.jsonl`
3. 记录 `swarmPrefixedAgent`（如 `mega_coder`）、`parentSessionId`、`planTaskId` 等

### 旁路：dispatch_lanes 的 output_ref

`src/tools/dispatch-lanes.ts:1380-1429` 为只读顾问通道（explorer/reviewer 等）生成结构化的 JSON 返回，其中包含 `session_id` 和 `output_ref`（如 `L1:abc...:def...:ghi...`）。`output_ref` 可由 `retrieve_lane_output` 工具查询完整输出。**这里的 output_ref 不是可点击链接，而是工具可用的引用标识符。**

---

## 2. 点击切换屏幕查看 subagent 输出的实现

### 完全由上游宿主实现

流程：

1. **分发时**：architect 调用 `Task(subagent_type='coder', prompt='...')`
2. **宿主创建子会话**：OpenCode 宿主创建一个新的子会话，分配 `sessionID`（如 `ses_xxx`）
3. **宿主渲染输出**：`Task` 工具的返回结果中含有 `<task id="ses_xxx" state="running">`
4. **宿主 UI 渲染链接**：TUI/GUI 宿主将此渲染为可点击的会话链接
5. **用户点击**：宿主 UI 将当前视图切换到子代理的会话，显示其所有消息
6. **子代理完成后**：宿主向父会话注入一条**合成消息**（synthetic message），其中包含 `<task id="ses_xxx" state="completed">` 完整信封

### 插件侧：合成完成事件监听

`src/background/completion-observer.ts:39-168` 监听 `message.part.updated` 事件，过滤 `synthetic === true` 的部分：

```typescript
if (part.synthetic !== true) return;                     // 第 55 行
const envelope = parseTaskEnvelope(part.text);            // 第 58 行
if (envelope.state !== 'completed' && envelope.state !== 'error') return;
```

匹配后：
- 通过 `.swarm/background-delegations.jsonl` 查找对应的待处理记录（第 62 行）
- 验证 `parentSessionId` 匹配（防止跨会话污染）
- 通过 `appendDelegationTransition()` 更新记录状态为 `completed`/`error`（第 123 行）
- 如果是 Stage B 门控记录，调用 `ingestBackgroundStageBCompletion()` 处理门证据（第 133 行）

---

## 3. Subagent 输出的保存机制

### 3a. 上游 OpenCode 宿主保存（全局）

所有会话消息（包括子代理会话）由 OpenCode 宿主保存在 `~/.cache/opencode/sessions/` 或 `~/.config/opencode/sessions/` 目录下。每个会话独立存储完整消息历史。插件不需要也不能干预。

### 3b. 后台委托 JSONL 日志

**文件**: `.swarm/background-delegations.jsonl`

`src/background/pending-delegations.ts:50-86` 定义了 `BackgroundDelegationRecord`：

| 字段 | 说明 |
|---|---|
| `correlationId` | 子代理 session ID（关联键） |
| `subagentSessionId` | 同上 |
| `parentSessionId` | 父架构师 session ID |
| `swarmPrefixedAgent` | 如 `mega_coder` |
| `normalizedAgent` | 如 `coder` |
| `status` | `pending` → `running` → `completed`/`error`/`stale`/`consumed` |
| `result.text` | 子代理最终输出文本 |
| `result.chars` | 字符数 |
| `result.digest` | SHA-256 摘要 |
| `result.outputRef` | 可选的大输出外部引用 |

写入流程：
- `recordPendingDelegation()`（第 287 行）：分发时追加 `pending` 快照
- `appendDelegationTransition()`（第 353 行）：完成/错误时追加终端快照
- 写操作通过 `withEvidenceLock` 实现项目级锁

### 3c. 顾问通道(Lane)输出存储

**文件路径**: `.swarm/lane-results/<batchDigest>/<laneDigest>/<outputDigest>.json`

`src/background/lane-output-store.ts:74-160` 存储 `dispatch_lanes` 输出的完整 JSON 工件：

```typescript
interface LaneOutputArtifact {
  schemaVersion: 1;
  ref: string;           // L1:<batchSHA256>:<laneSHA256>:<outputSHA256>
  batchId: string;
  laneId: string;
  agent: string;
  role: string;
  sessionId?: string;
  text: string;          // 完整转录用文本
  chars: number;
  bytes: number;
  digest: string;
  messageCount?: number;
  transcriptIncomplete?: boolean;
}
```

- 最大存储限制：10MB（`MAX_LANE_OUTPUT_STORED_BYTES`，第 15 行）
- 超限时 `degraded: true`，不写入文件
- 通过 `retrieve_lane_output` 工具按页查询（`src/tools/retrieve-lane-output.ts`）

---

## 4. 关于增加 UI 元素

**opencode-swarm 当前是 Server Plugin，不能直接操作 UI。** 如果要增加状态栏链接或侧边栏子代理列表：

### 方式 A：改为/增加 TUI Plugin 导出

当前插件仅导出 `{ id, server }`（`src/index.ts:2610`）。要访问 UI API，需要同时导出 `{ id, server, tui }`。

**依赖包**（`@opencode-ai/plugin` 的 peerDependencies，均为 optional）：

| 包名 | 用途 |
|---|---|
| `@opentui/core` | TUI 基础框架 |
| `@opentui/keymap` | 键盘快捷键管理 |
| `@opentui/solid` | Solid.js 组件渲染 |

在 `package.json` 中声明（optional peer deps，不需要直接 `npm install`）：

```json
"peerDependencies": {
  "@opentui/core": ">=0.4.3",
  "@opentui/solid": ">=0.4.3",
  "@opentui/keymap": ">=0.4.3"
},
"peerDependenciesMeta": {
  "@opentui/core": { "optional": true },
  "@opentui/solid": { "optional": true },
  "@opentui/keymap": { "optional": true }
}
```

### 方式 B：利用 TUI Slot 系统（推荐）

TUI Plugin API (`@opencode-ai/plugin/dist/tui.d.ts:355-406`) 提供以下注入点：

| Slot 名称 | 位置 | Props |
|---|---|---|
| `app_bottom` | 底部状态栏区域 | `{}` |
| `sidebar_content` | 右侧边栏内容区 | `{ session_id }` |
| `sidebar_title` | 侧边栏标题区 | `{ session_id, title, share_url? }` |
| `sidebar_footer` | 侧边栏底部 | `{ session_id }` |

### 方式 C：注册自定义路由

`api.route.register(routes: TuiRouteDefinition[])` 可注册自定义全屏页面（如子代理输出查看器）：

```typescript
api.route.register([
  {
    name: 'subagent-output',
    render: ({ params }) => <SubagentOutputView sessionID={params.sessionID} />,
  },
]);
```

然后通过 `api.route.navigate('subagent-output', { sessionID: 'ses_xxx' })` 导航。

### 方式 D：通过 Server Plugin 间接实现

即使不改为 TUI Plugin，也可以通过 Server Plugin 的 `experimental.chat.messages.transform` 钩子在消息流中注入 `<task>` 标签文本来生成可点击链接。但这限制较大——只能影响消息文本，无法控制状态栏或侧边栏。

---

## 5. 实战代码示例

### 示例 1：从 architect prompt 中调用 `Task` 工具分发子代理

这是 architect 写入 prompt 中的内容，OpenCode 宿主会将其解析为工具调用：

```
将以下任务派发给 coder：

Task(subagent_type="mega_coder",
     background=true,
     description="实现用户登录功能",
     prompt="请实现以下功能：\n1. 用户登录 API\n2. 会话管理\n3. 错误处理\n\n文件范围: src/auth/login.ts")
```

关键参数：
- `subagent_type` — 子代理类型，如 `mega_coder`、`mega_reviewer`
- `background` — `true` 表示后台异步执行（立即返回 running，完成后注入合成消息）
- `prompt` — 子代理的任务描述

### 示例 2：从 architect prompt 中调用 `dispatch_lanes_async` 分发顾问通道

```javascript
dispatch_lanes_async({
  lanes: [
    {
      id: "explore-auth",
      agent: "mega_explorer",
      prompt: "调研项目中现有的认证实现方式，列出所有相关的文件和关键函数。"
    },
    {
      id: "review-security",
      agent: "mega_reviewer",
      prompt: "审查 src/auth/login.ts 的安全性，关注 SQL 注入和 XSS 风险。"
    }
  ],
  max_concurrent: 2,
  mode: "deep-dive"
})
```

### 示例 3：从 architect prompt 中调用 `collect_lane_results` 收集通道结果

```javascript
collect_lane_results({
  batch_id: "batch_f3a1b2c3",
  wait: true  // true = 阻塞直到所有通道完成并返回结果
})
```

### 示例 4：从 architect prompt 中调用 `retrieve_lane_output` 查看完整通道输出

```javascript
retrieve_lane_output({
  ref: "L1:a1b2c3d4e5...abcdef:123456...789abc:def012...345678",
  offset: 0,
  limit: 200
})
```

### 示例 5：编程方式读取 `.swarm/background-delegations.jsonl`

```typescript
import { readFileSync } from 'node:fs';
import { z } from 'zod';                             // ^4.1.8

const DelegationSchema = z.object({
  schemaVersion: z.union([z.literal(1), z.literal(2)]),
  correlationId: z.string(),
  subagentSessionId: z.string(),
  parentSessionId: z.string(),
  swarmPrefixedAgent: z.string(),
  normalizedAgent: z.string(),
  status: z.enum(['pending', 'running', 'completed', 'error', 'stale', 'consumed']),
  result: z.object({
    text: z.string().optional(),
    error: z.string().optional(),
    chars: z.number(),
    digest: z.string(),
    outputRef: z.string().optional(),
  }).optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  laneId: z.string().optional(),
  batchId: z.string().optional(),
});

export function readDelegations(directory: string): Array<z.infer<typeof DelegationSchema>> {
  const filePath = path.join(directory, '.swarm', 'background-delegations.jsonl');
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }
  const folded = new Map<string, z.infer<typeof DelegationSchema>>();
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parsed = DelegationSchema.safeParse(JSON.parse(trimmed));
    if (!parsed.success) continue;
    // 同 correlationId 只保留最后一条（最新状态）
    folded.set(parsed.data.correlationId, parsed.data);
  }
  return [...folded.values()];
}

// 获取当前活跃（running）的子代理列表
export function getActiveSubagents(directory: string) {
  return readDelegations(directory).filter(
    d => d.status === 'pending' || d.status === 'running'
  );
}
```

### 示例 6：编程方式读取 Lane 输出工件

```typescript
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import * as path from 'node:path';

const LANE_RESULTS_DIR = 'lane-results';

export function readLaneOutput(swarmDir: string, ref: string) {
  // ref 格式: L1:<batchSHA256>:<laneSHA256>:<outputSHA256>
  const parts = ref.split(':');
  if (parts.length !== 4 || parts[0] !== 'L1') return null;
  const [, batchDigest, laneDigest, outputDigest] = parts;

  const filePath = path.join(swarmDir, LANE_RESULTS_DIR, batchDigest, laneDigest, `${outputDigest}.json`);
  if (!existsSync(filePath)) return null;

  return JSON.parse(readFileSync(filePath, 'utf-8'));
}

// 用法
const artifact = readLaneOutput('.swarm', 'L1:a1b2...f3e4:5678...90ab:cdef...1234');
console.log(artifact.agent);  // 如 "mega_explorer"
console.log(artifact.text);   // 通道的完整输出文本
```

### 示例 7：完整的 TUI Plugin 实现（注册 sidebar 槽位显示子代理列表）

```typescript
// tui-plugin.ts — 需要 @opencode-ai/plugin, @opentui/solid, @opentui/core
import type { TuiPluginApi } from '@opencode-ai/plugin/tui';
import { readDelegations } from './background/pending-delegations';

export const tui: TuiPlugin = async (api: TuiPluginApi) => {
  // 注册一个 sidebar_content 槽位，在侧边栏显示当前活跃的子代理列表
  api.slots.register({
    name: 'sidebar_content',
    render: (props: { session_id: string }) => {
      const directory = api.state.path.directory;
      const delegations = readDelegations(directory);
      const active = delegations.filter(
        d => d.parentSessionId === props.session_id &&
             (d.status === 'pending' || d.status === 'running')
      );

      return (
        <div style="padding: 8px">
          <h3 style="font-weight: bold; margin-bottom: 8px">
            活跃子代理 ({active.length})
          </h3>
          {active.length === 0 ? (
            <p style="color: #888">暂无活跃子代理</p>
          ) : (
            <ul style="list-style: none; padding: 0">
              {active.map(d => (
                <li style="margin-bottom: 4px">
                  <a
                    href="#"
                    onClick={() =>
                      api.route.navigate('session', {
                        sessionID: d.subagentSessionId
                      })
                    }
                    style="color: #4A9EFF; text-decoration: underline; cursor: pointer"
                  >
                    {d.swarmPrefixedAgent}
                  </a>
                  <span style="color: #888; font-size: 0.9em; margin-left: 8px">
                    [{d.status}]
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      );
    },
  });

  // 注册状态栏插槽，显示子代理数量
  api.slots.register({
    name: 'app_bottom',
    render: () => {
      const directory = api.state.path.directory;
      const delegations = readDelegations(directory);
      const active = delegations.filter(
        d => d.status === 'pending' || d.status === 'running'
      ).length;

      return (
        <span style="padding: 0 12px; color: #888">
          子代理: {active} 活跃
        </span>
      );
    },
  });
};
```

### 示例 8：注册自定义全屏子代理输出查看页

```typescript
// tui-plugin.ts 中补充
api.route.register([
  {
    name: 'subagent-output',
    render: ({ params }) => {
      const sessionID = params?.sessionID as string;
      const directory = api.state.path.directory;
      const delegations = readDelegations(directory);
      const record = delegations.find(d => d.subagentSessionId === sessionID);

      if (!record) {
        return <div style="padding: 16px; color: red">未找到子代理记录</div>;
      }

      return (
        <div style="padding: 16px">
          <h2>{record.swarmPrefixedAgent}</h2>
          <p>状态: {record.status}</p>
          <p>Session ID: {record.subagentSessionId}</p>
          <pre style="background: #1e1e1e; padding: 12px; border-radius: 4px; overflow: auto; max-height: 80vh">
            {record.result?.text || '(无输出)'}
          </pre>
          <button onClick={() => api.route.navigate('session', { sessionID })}>
            查看完整会话
          </button>
        </div>
      );
    },
  },
]);
```

### 示例 9：更新 `src/index.ts` 插件入口同时注册 TUI

```typescript
// src/index.ts
import type { Plugin } from '@opencode-ai/plugin';
import type { TuiPluginApi } from '@opencode-ai/plugin/tui';

// 原有的 server 插件
const server: Plugin = async (input) => ({
  tool: { ... },
  agent: { ... },
  config: { ... },
  // ... 其他 hooks
});

// 新增的 tui 插件
const tui = async (api: TuiPluginApi) => {
  api.slots.register({ /* ... 槽位定义 ... */ });
  api.route.register([ /* ... 自定义路由 ... */ ]);
};

export default { id: 'opencode-swarm', server, tui };
```

---

## 6. 依赖总表

| 包名 | 版本 | 用途 | 何时需要 |
|---|---|---|---|
| `@opencode-ai/plugin` | ^1.1.53 | 核心插件 SDK（server + tui 类型定义） | 总是需要 |
| `@opencode-ai/sdk` | ^1.1.53 | OpenCode SDK 基础类型 | 总是需要 |
| `zod` | ^4.1.8 | Schema 验证（解析 JSONL 时用） | 读取 delegation/lane 记录时 |
| `@opentui/solid` | >=0.4.3 | Solid.js 组件渲染 TUI 插槽 | **仅 TUI Plugin 时需要** |
| `@opentui/core` | >=0.4.3 | TUI 基础框架 | **仅 TUI Plugin 时需要** |
| `@opentui/keymap` | >=0.4.3 | 键盘绑定 | **仅 TUI Plugin 时需要** |

---

## 7. 数据流全景图

```
Architect 调用 Task() 或 dispatch_lanes_async()
         │
         ▼
┌─────────────────────────────────────────────────┐
│ OpenCode 宿主 (Host)                            │
│  1. 创建子会话 (sessionID = ses_xxx)             │
│  2. 渲染输出: <task id="ses_xxx" state="running">│
│  3. TUI/GUI 自动渲染为可点击链接                 │
│  4. 用户点击 → 切换到子会话视图                   │
│  5. 子代理完成 → 注入合成消息到父会话             │
└──────────┬──────────────────────────────────────┘
           │ <task id="..." state="completed">
           ▼
┌──────────────────────────────────────────────────┐
│ opencode-swarm (Server Plugin)                   │
│                                                  │
│ delegation-gate.ts (toolAfter 钩子)               │
│   ├─ extractDispatchIds()    解析 sessionID      │
│   └─ recordPendingDelegation()                   │
│        └─ .swarm/background-delegations.jsonl    │
│                                                  │
│ completion-observer.ts (event 监听器)             │
│   ├─ 匹配 synthetic === true 的 message.part     │
│   ├─ parseTaskEnvelope()    提取 + 验证          │
│   ├─ findByCorrelationId()  关联原始委托记录     │
│   ├─ appendDelegationTransition()  更新状态      │
│   └─ ingestBackgroundStageBCompletion()  门控    │
│                                                  │
│ dispatch-lanes.ts (工具实现)                      │
│   ├─ storeLaneOutput()  → .swarm/lane-results/   │
│   └─ recordToLaneResult() → session_id,output_ref│
└──────────────────────────────────────────────────┘
```

---

## 关键文件索引

| 问题 | 文件 | 关键行 |
|---|---|---|
| Task 信封解析 | `src/background/task-envelope.ts` | 36-76, 112-153 |
| 后台委托持久化 | `src/background/pending-delegations.ts` | 50-86, 287-404 |
| 门控钩子(分发+完成) | `src/hooks/delegation-gate.ts` | 1630-1715 |
| Lane 输出存储 | `src/background/lane-output-store.ts` | 74-160, 181-275 |
| Lane 输出查询工具 | `src/tools/retrieve-lane-output.ts` | 30-106 |
| 合成完成事件监听 | `src/background/completion-observer.ts` | 39-168 |
| Stage B 门摄入 | `src/background/stage-b-gates.ts` | 80-138 |
| dispatch_lanes 输出格式 | `src/tools/dispatch-lanes.ts` | 231-282, 1223-1429 |
| TUI 插件类型定义 | `.opencode/node_modules/@opencode-ai/plugin/dist/tui.d.ts` | 355-510 |
| 插件入口（Server） | `src/index.ts` | ~2610 |
| createSwarmTool 辅助函数 | `src/tools/create-tool.ts` | 55-91 |
