# OpenCode Subagent 输出到主 Agent 界面分析

## 1. 系统架构概述

OpenCode Swarm 采用中心辐条架构（hub-and-spoke）：
- **Architect** 作为中央协调器
- **Dynamic SME**（领域专家）进行串行咨询
- 代码生成通过 **QA review** 进行验证
- 支持迭代式改进和triage

## 2. Subagent 输出机制

### 2.1 输出信封格式（Task Envelope）

OpenCode v1.16.2+ 版本使用稳定的 XML 信封格式来表示 subagent 调度和完成：

```xml
<task id="<subagentSessionID>" state="running|completed|error">
<summary>...</summary>
<task_result>...</task_result>   <!-- 或 <task_error> for state="error" -->
</task>
```

**关键特性**：
- `sessionId`: subagent 会话 ID，跨事件关联键
- `state`: 任务状态（running/completed/error）
- `summary`: 任务摘要
- `task_result`: 成功时的结果文本
- `task_error`: 错误时的错误文本
- 文本最大限制：20,000 字符（超过则截断）

### 2.2 输出传输路径

```
Subagent Execution
    ↓
Task Envelope Render (renderOutput)
    ↓
Tool Result (tool.execute.after)
    ↓
Main Agent Context
    ↓
User Interface (GUI/TUI)
```

## 3. 输出传递机制详细分析

### 3.1 Task 工具调用返回

当主 agent 调用 `Task` 工具启动 subagent 时：

```typescript
// 调度时的输出
{
  title: "Launched subagent",
  output: `<task id="subagent-session-123" state="running">
<summary>Executing task...</summary>
</task>`,
  metadata: { background: true, jobId: "job-456" }
}
```

### 3.2 Subagent 完成时的输出

Subagent 完成后，通过合成父消息部分（synthetic parent message part）传递结果：

```typescript
// 完成时的输出
{
  output: `<task id="subagent-session-123" state="completed">
<summary>Task completed successfully</summary>
<task_result>
Subagent 的完整输出文本...
包括所有的分析和建议...
</task_result>
</task>`
}
```

### 3.3 输出解析（parseTaskEnvelope）

位于 `src/background/task-envelope.ts:44`：

```typescript
export function parseTaskEnvelope(text: unknown): TaskEnvelope | null {
  // 解析 XML 信封
  const match = text.match(TASK_ENVELOPE_RE);
  // 提取 sessionId, state, summary, resultText/errorText
  return {
    sessionId,
    state,
    summary,
    resultText, // 或 errorText
    resultChars,
    resultTruncated
  };
}
```

### 3.4 Micro-Reflection 处理

位于 `src/hooks/micro-reflector.ts:449`：

当 subagent 返回结果时，系统会：

1. **读取输出文本**：从 `output.output` 字段提取
2. **解析任务 ID**：从 prompt 参数中提取
3. **读取轨迹**：从 `.swarm/evidence/<taskId>/trajectory.jsonl` 读取
4. **分类结果**：成功/失败/部分完成
5. **可选 LLM 反思**：对于失败结果生成可学习的教训

关键代码：

```typescript
export async function microReflectorAfter(
  directory: string,
  input: MicroReflectorInput,
  output: MicroReflectorOutput,
  llmDelegate?: CuratorLLMDelegate,
  quota?: EnrichmentQuotaOptions,
): Promise<void> {
  if (!isTaskTool(input.tool)) return;
  const transcript = typeof output.output === 'string' ? output.output : '';
  if (!transcript) return;

  const agent = parsed ? stripKnownSwarmPrefix(parsed.targetAgent) : 'unknown';
  const taskId = extractTaskId(prompt);
  const trajectory = taskId ? await readTaskTrajectory(directory, taskId) : [];

  await runMicroReflection({
    directory,
    taskId,
    agent,
    transcript,  // ← Subagent 的完整输出
    trajectory,
    llmDelegate,
    quota,
  });
}
```

## 4. 输出显示机制

### 4.1 主 Agent 界面显示

Subagent 的输出通过以下方式显示在主 agent 界面：

1. **直接工具输出**：Task 工具的返回值包含完整的 subagent 输出
2. **消息历史**：输出被添加到对话历史中
3. **GUI/TUI 渲染**：OpenCode 客户端渲染这些消息

**显示格式**：

```
[Task] Launched subagent "reviewer"
┌─────────────────────────────────┐
│ <task id="session-123" state="running"> │
│ <summary>Reviewing code...</summary> │
│ </task>                           │
└─────────────────────────────────┘

[Task] Completed
┌─────────────────────────────────┐
│ <task id="session-123" state="completed"> │
│ <summary>Review completed</summary> │
│ <task_result>                   │
│ Code review findings:           │
│ - File A: Line 10 - Missing error handling │
│ - File B: Line 25 - Potential null pointer │
│ ... 完整输出文本 ...              │
│ </task_result>                   │
│ </task>                          │
└─────────────────────────────────┘
```

### 4.2 持久化输出

可选地将输出持久化到 `.swarm/outputs/` 目录（通过 `agent-writer.ts`）：

```
.swarm/outputs/phase-1/task-1/reviewer-review-2026-03-06T10-30-00.000Z.md
```

格式包含 YAML frontmatter：

```yaml
---
agent: reviewer
type: review
taskId: task-1
phase: 1
timestamp: 2026-03-06T10:30:00.000Z
durationMs: 5000
success: true
---

[Review 内容...]
```

## 5. 输出限制和安全特性

### 5.1 输出大小限制

- **信封文本限制**：20,000 字符
- **超过限制**：自动截断并标记 `resultTruncated: true`
- **截断标记**：`\n[... ${omitted} chars truncated by task-envelope ...]`

### 5.2 安全特性

1. **纯解析器**：永不抛出异常，防御性解析
2. **ID 验证**：非空 sessionId 检查
3. **状态约束**：只接受已知的状态值
4. **元数据隔离**：jobId 从结构化元数据读取（非自由文本）

### 5.3 防护措施

```typescript
// 防止不受信的 XML 标签注入
const TASK_ENVELOPE_RE =
  /<task\s+id="([^"]+)"\s+state="(running|completed|error)"\s*>/;

// 防止过大的输出
const MAX_TASK_ENVELOPE_TEXT_CHARS = 20_000;
```

## 6. 多轮对话和上下文传递

### 6.1 输出作为上下文

Subagent 的输出成为主 agent 的对话上下文的一部分：

```
主 Agent → Task 工具（启动 Subagent）
  ↓
Subagent 执行并产生输出
  ↓
输出 → Task 工具返回 → 主 Agent 上下文
  ↓
主 Agent 可以引用 Subagent 的输出进行后续决策
```

### 6.2 输出引用示例

主 agent 可以引用 subagent 的输出：

```
根据 reviewer 的审查结果，发现 3 个问题需要修复：
1. File A: Line 10 - 缺少错误处理
2. File B: Line 25 - 潜在的空指针
3. File C: Line 50 - 未使用的变量

让我开始修复这些问题...
```

## 7. 后台 Subagent 支持（v1.16.2+）

### 7.1 后台完成观察器

OpenCode v1.16.2+ 支持后台 subagent 完成，通过事件观察器：

```typescript
const backgroundCompletionObserver = createBackgroundCompletionObserver({
  config: {
    enabled: config.hooks.background_subagents === true
  },
  directory: ctx.directory,
});
```

### 7.2 延迟完成信号

后台 subagent 完成时，通过合成父消息部分传递结果：

```typescript
// 延迟完成的格式
{
  role: 'user',
  parts: [{
    type: 'text',
    text: `<task id="subagent-session-123" state="completed">
<task_result>...输出内容...</task_result>
</task>`
  }]
}
```

## 8. 输出可视化层次

### 8.1 原始输出层

- XML 信封格式（`<task>` 标签）
- 包含结构化元数据（id, state）

### 8.2 解析输出层

- 解析后的 TaskEnvelope 对象
- 提取的 sessionId, resultText, summary

### 8.3 显示层

- GUI/TUI 渲染的格式化文本
- 可选的 Markdown 格式化
- 可选的持久化文件

## 9. 结论

### 9.1 Subagent 能否输出到主 Agent 界面？

**答案：可以，完全支持。**

Subagent 的输出通过以下机制传递到主 agent 界面：

1. ✅ **Task 信封格式**：结构化的 XML 信封包含完整输出
2. ✅ **工具结果传递**：通过 Task 工具的返回值传递
3. ✅ **消息历史集成**：输出被添加到对话历史
4. ✅ **GUI/TUI 渲染**：客户端自动渲染这些消息
5. ✅ **上下文引用**：主 agent 可以引用 subagent 输出进行决策

### 9.2 关键代码位置

| 功能 | 文件位置 |
|------|----------|
| Task 信封解析 | `src/background/task-envelope.ts:44` |
| 输出提取 | `src/hooks/micro-reflector.ts:449` |
| 持久化输出 | `src/output/agent-writer.ts:36` |
| 后台观察器 | `src/background/completion-observer.ts` |
| 插件注册 | `src/index.ts:533` |

### 9.3 输出流程总结

```
Subagent 执行
    ↓
生成结果文本
    ↓
包装成 Task 信封
    ↓
Task 工具返回
    ↓
Main Agent 接收
    ↓
添加到消息历史
    ↓
GUI/TUI 渲染显示
    ↓
用户可见完整输出
```

**完全支持 subagent 输出到主 agent 输出界面**，并且输出可以持久化、作为上下文引用、以及进行后续分析处理。