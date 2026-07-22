# OpenCode AgentType 类型与自定义方法

## 1. OpenCode 内置 AgentType 列表

### 1.1 Primary Agents（主要代理）

主要代理是你可以直接交互的主助手。使用 **Tab** 键或配置的 `switch_agent` 快捷键在它们之间切换。

| AgentType | 说明 | 工具权限 | UI 可见 |
|-----------|------|---------|---------|
| `build` | 默认主要代理，启用所有工具 | 全部启用 | ✅ 可选 |
| `plan` | 受限代理，用于规划和分析 | 禁用编辑和 bash | ✅ 可选 |
| `compaction` | 系统代理，压缩长上下文 | 系统 | ❌ 隐藏 |
| `title` | 系统代理，生成会话标题 | 系统 | ❌ 隐藏 |
| `summary` | 系统代理，创建会话摘要 | 系统 | ❌ 隐藏 |

### 1.2 Subagents（子代理）

子代理是可以被主要代理调用的专门助手，也可以通过 **@ 提及** 手动调用。

| AgentType | 说明 | 工具权限 | 适用场景 |
|-----------|------|---------|---------|
| `general` | 通用代理，研究复杂问题和执行多步骤任务 | 全部工具（除了 todo） | 需要文件修改的多步任务 |
| `explore` | 快速的只读代理，探索代码库 | 只读（glob, grep, read, list） | 快速查找文件、搜索代码、回答代码库问题 |
| `scout` | 只读代理，外部文档和依赖研究 | 只读 + 外部目录访问 | 克隆依赖仓库、检查库源码、跨引用本地代码 |

### 1.3 在 Task 工具中使用的 SubagentType

**注意**：只有 `mode: subagent` 的代理才能作为 `subagent_type` 参数传递给 Task 工具。

可用的内置 subagent_type 值：
- `general`
- `explore`
- `scout`

**重要约束**（来自 swarm-subagent-screen.md）：
- `subagent_type` 必须是 `"explore"`，**不是** `"explorer"`，否则 Task 工具会报错

---

## 2. 自定义 AgentType 的方法

### 2.1 方法一：JSON 配置

在 `opencode.json` 配置文件中定义自定义代理：

**文件位置**：
- 全局：`~/.config/opencode/opencode.json`
- 项目级：`.opencode/opencode.json`

**示例配置**：
```json
{
  "$schema": "https://opencode.ai/config.json",
  "agent": {
    "code-reviewer": {
      "description": "Reviews code for best practices and potential issues",
      "mode": "subagent",
      "model": "anthropic/claude-sonnet-4-20250514",
      "prompt": "You are a code reviewer. Focus on security, performance, and maintainability.",
      "permission": {
        "edit": "deny",
        "bash": "deny"
      }
    },
    "debug-helper": {
      "description": "Focused on investigation with bash and read tools enabled",
      "mode": "subagent",
      "permission": {
        "bash": "allow",
        "read": "allow",
        "grep": "allow",
        "edit": "deny"
      }
    }
  }
}
```

### 2.2 方法二：Markdown 配置（推荐）

使用 Markdown 文件定义代理，更加直观和易维护。

**文件位置**：
- 全局：`~/.config/opencode/agents/`
- 项目级：`.opencode/agents/`

**示例 1：代码审查代理**
`~/.config/opencode/agents/code-reviewer.md`：
```yaml
---
description: Reviews code for quality and best practices
mode: subagent
model: anthropic/claude-sonnet-4-20250514
temperature: 0.1
permission:
  edit: deny
  bash: deny
---
You are in code review mode. Focus on:
- Code quality and best practices
- Potential bugs and edge cases
- Performance implications
- Security considerations

Provide constructive feedback without making direct changes.
```

**示例 2：调试助手代理**
`.opencode/agents/debug-helper.md`：
```yaml
---
description: Focused on investigation with bash and read tools
mode: subagent
permission:
  bash: allow
  read: allow
  grep: allow
  glob: allow
  edit: deny
---
You are a debugging specialist. Focus on:
- Investigating issues using logs and system commands
- Tracing execution flows
- Identifying root causes
- Providing diagnostic information

Use bash commands and code analysis tools to gather information.
```

**示例 3：文档编写代理**
`.opencode/agents/docs-writer.md`：
```yaml
---
description: Writes and maintains project documentation
mode: subagent
permission:
  bash: deny
---
You are a technical writer. Create clear, comprehensive documentation.
Focus on:
- Clear explanations
- Proper structure
- Code examples
- User-friendly language
```

**示例 4：安全审计代理**
`.opencode/agents/security-auditor.md`：
```yaml
---
description: Performs security audits and identifies vulnerabilities
mode: subagent
permission:
  edit: deny
  bash: deny
---
You are a security expert. Focus on identifying potential security issues.
Look for:
- Input validation vulnerabilities
- Authentication and authorization flaws
- Data exposure risks
- Dependency vulnerabilities
- Configuration security issues
```

### 2.3 方法三：交互式创建（推荐新手）

OpenCode 提供了交互式命令来创建新代理：

```bash
opencode agent create
```

这个命令会：
1. 询问保存位置（全局还是项目级）
2. 询问代理应该做什么的描述
3. 生成适当的系统提示和标识符
4. 让你选择代理应该被允许的权限（未选择的将被拒绝）
5. 最后创建包含代理配置的 markdown 文件

---

## 3. Agent 配置选项详解

### 3.1 必需选项

| 选项 | 类型 | 说明 |
|------|------|------|
| `description` | string | 代理的简要描述，说明它做什么以及何时使用 |
| `mode` | string | 代理模式：`primary`、`subagent` 或 `all`（默认：`all`） |

### 3.2 可选选项

| 选项 | 类型 | 说明 | 示例值 |
|------|------|------|--------|
| `model` | string | 覆盖代理使用的模型 | `anthropic/claude-sonnet-4-20250514` |
| `temperature` | number | 控制响应的随机性和创造性（0.0-1.0） | `0.1`（专注）, `0.7`（创意） |
| `top_p` | number | 控制响应多样性的替代方法（0.0-1.0） | `0.9` |
| `steps` / `maxSteps` | number | 代理可以执行的最大迭代次数 | `5` |
| `prompt` | string | 自定义系统提示文件路径 | `"{file:./prompts/build.txt}"` |
| `permission` | object | 控制代理可以执行的操作 | 详见下文 |
| `hidden` | boolean | 从 `@` 自动完成菜单中隐藏子代理 | `true` |
| `color` | string | 自定义代理在 UI 中的视觉外观 | `#ff6b6b` 或 `accent` |
| `disable` | boolean | 禁用代理 | `true` |

### 3.3 Permission 权限配置

权限键可以设置为：
- `"ask"` — 运行工具前提示批准
- `"allow"` — 允许所有操作无需批准
- `"deny"` — 禁用工具

**可用的权限键**：

| 权限键 | 控制的工具 |
|--------|-----------|
| `read` | `read` |
| `edit` | `write`, `edit`, `apply_patch` |
| `glob` | `glob` |
| `grep` | `grep` |
| `list` | `list` |
| `bash` | `bash` |
| `task` | `task` |
| `external_directory` | 在项目工作树之外读取或写入文件的任何工具 |
| `todowrite` | `todowrite`, `todoread` |
| `webfetch` | `webfetch` |
| `websearch` | `websearch` |
| `lsp` | `lsp` |
| `skill` | `skill` |
| `question` | `question` |
| `doom_loop` | 代理似乎卡住时的恢复提示 |

**精细权限控制示例**：

```json
{
  "agent": {
    "build": {
      "permission": {
        "bash": {
          "git push": "ask",
          "git status *": "allow",
          "grep *": "allow",
          "*": "ask"
        },
        "edit": "allow"
      }
    }
  }
}
```

**注意**：规则按顺序评估，**最后匹配的规则获胜**。

### 3.4 Task 权限控制

使用 `permission.task` 控制代理可以通过 Task 工具调用哪些子代理。使用 glob 模式进行灵活匹配。

```json
{
  "agent": {
    "orchestrator": {
      "mode": "primary",
      "permission": {
        "task": {
          "*": "deny",
          "orchestrator-*": "allow",
          "code-reviewer": "ask"
        }
      }
    }
  }
}
```

**注意**：当设置为 `deny` 时，子代理将从 Task 工具描述中完全移除，因此模型不会尝试调用它。用户始终可以通过 `@` 自动完成菜单直接调用任何子代理，即使代理的任务权限会拒绝它。

---

## 4. 使用自定义 AgentType

### 4.1 在 Task 工具中使用

一旦你创建了自定义的 `mode: subagent` 代理，就可以在 Task 工具中使用它：

```javascript
Task({
  subagent_type: "code-reviewer",
  description: "Review the login feature",
  prompt: "Please review the authentication code in src/auth/login.ts for security issues."
})
```

### 4.2 通过 @ 提及使用

在消息中直接提及子代理：

```
@code-reviewer Please review the changes in the latest commit.
```

### 4.3 切换 Primary Agents

使用 **Tab** 键或配置的快捷键在主要代理之间切换。

---

## 5. 最佳实践

### 5.1 选择合适的 Mode

- **Primary Agents**：用户主要交互的助手（如 `build`、`plan`）
- **Subagents**：由主要代理调用的专门助手（如 `code-reviewer`、`debug-helper`）

### 5.2 权限最小化原则

为代理分配最小必要权限：
- 只读代理：禁用 `edit` 和 `bash`
- 审查代理：禁用所有修改操作
- 调试代理：只启用 `bash`、`read`、`grep`

### 5.3 描述清晰明确

`description` 字段应该：
- 说明代理的用途
- 指导何时使用
- 帮助模型理解何时调用它

### 5.4 使用 Markdown 配置

- 更易读和维护
- 支持 YAML frontmatter
- 自动将文件名作为代理名称

### 5.5 Temperature 配置建议

| 任务类型 | Temperature 值 |
|---------|---------------|
| 代码分析、规划 | 0.0-0.2 |
| 一般开发任务 | 0.3-0.5 |
| 头脑风暴、探索 | 0.6-1.0 |

---

## 6. 常见用例示例

### 6.1 代码审查代理

```yaml
---
description: Reviews code for quality and best practices
mode: subagent
permission:
  edit: deny
  bash: deny
---
You are a code reviewer. Focus on:
- Code quality and best practices
- Potential bugs and edge cases
- Performance implications
- Security considerations
```

### 6.2 安全审计代理

```yaml
---
description: Performs security audits and identifies vulnerabilities
mode: subagent
permission:
  edit: deny
---
You are a security expert. Focus on identifying potential security issues.
Look for:
- Input validation vulnerabilities
- Authentication and authorization flaws
- Data exposure risks
```

### 6.3 调试助手代理

```yaml
---
description: Focused on investigation with bash and read tools
mode: subagent
permission:
  bash: allow
  read: allow
  grep: allow
  edit: deny
---
You are a debugging specialist. Use bash commands and code analysis to investigate issues.
```

### 6.4 文档编写代理

```yaml
---
description: Writes and maintains project documentation
mode: subagent
permission:
  bash: deny
---
You are a technical writer. Create clear, comprehensive documentation with proper structure and examples.
```

---

## 7. 故障排除

### 7.1 代理未出现在 @ 自动完成菜单中

**原因**：
- 代理设置为 `hidden: true`
- 代理 `disable: true`
- 配置文件路径错误

**解决方案**：
- 检查 `hidden` 和 `disable` 设置
- 确认配置文件在正确位置
- 重启 OpenCode

### 7.2 Task 工具无法调用自定义子代理

**原因**：
- 代理 `mode` 不是 `subagent`
- 父代理的 `permission.task` 拒绝了调用
- 代理被禁用

**解决方案**：
- 确认 `mode: subagent`
- 检查父代理的 `permission.task` 配置
- 确保 `disable: false`

### 7.3 代理执行了不允许的操作

**原因**：
- 权限配置不正确
- 权限规则顺序错误

**解决方案**：
- 审查 `permission` 配置
- 确认规则顺序（最后匹配的规则获胜）
- 使用明确的权限设置而非通配符

---

## 8. 参考资料

- [OpenCode 官方文档 - Agents](https://opencode.ai/docs/agents)
- [OpenCode 官方文档 - Config](https://opencode.ai/docs/config)
- [OpenCode 官方文档 - Permissions](https://opencode.ai/docs/permissions)
- [OpenCode GitHub 仓库](https://github.com/anomalyco/opencode)

---

**文档版本**：1.0
**最后更新**：2026-07-22
**适用版本**：OpenCode 最新版本
