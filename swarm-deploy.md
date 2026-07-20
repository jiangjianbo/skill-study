# opencode-swarm 打包与部署分析

## 1. 项目是如何打包的

### 构建方式

使用 **Bun** 作为构建工具，构建脚本定义在 `package.json` 中：

```json
"build": "bun run clean && bun run scripts/copy-grammars.ts && bun build src/index.ts --outdir dist --target node --format esm --external web-tree-sitter --minify-whitespace --minify-syntax && bun build src/cli/index.ts --outdir dist/cli --target bun --format esm --external bash-parser --splitting && bun run scripts/copy-grammars.ts --to-dist && tsc --emitDeclarationOnly"
```

构建分三步并行：

| 步骤 | 命令 | 输出 |
|------|------|------|
| **主插件入口** | `bun build src/index.ts` → `target: node, format: esm` | `dist/index.js` (Node-ESM 可加载的插件 bundle) |
| **CLI 入口** | `bun build src/cli/index.ts` → `target: bun, format: esm, --splitting` | `dist/cli/index.js` (Bun 可执行 CLI) |
| **类型声明** | `tsc --emitDeclarationOnly` | `dist/index.d.ts` (TypeScript 类型) |
| **语法文件** | `scripts/copy-grammars.ts` 复制 Tree-sitter WASM 文件 | `dist/lang/grammars/*.wasm` |

### 包的内容形态

`package.json#files` 控制哪些文件进入 npm 包：

```
dist/                          # 编译产物
dist/lang/grammars/            # Tree-sitter 语法 WASM 文件
.opencode/skills/*/            # 30+ 项目技能 (SKILL.md 文件)
tests/fixtures/memory-recall/  # 测试夹具
README.md
LICENSE
```

npm 包中**不包含**：`src/`, `.github/`, `.swarm/`, `tests/`, Node 依赖会在安装时自动安装。

### npm 发布流程

整个发布由 **release-please** 全自动完成，没有任何手动步骤。

#### 触发机制

`.github/workflows/release-and-publish.yml`:

```yaml
on:
  push:
    branches: [main]
```

#### 工作流

1. **release-please** 扫描合并到 `main` 的 commit 消息，按 Conventional Commits 确定版本号
2. 创建/更新一个 release PR（如 `chore(main): release 6.41.0`），自动修改 `package.json` 版本、`CHANGELOG.md`、`.release-please-manifest.json`
3. `update-pr-notes` job 聚合每个 PR 的 `docs/releases/pending/<slug>.md` 片段到 release PR body
4. release PR 被合并后，创建 git tag + GitHub Release
5. **`publish-npm` job 执行**：

```yaml
- run: bun install --frozen-lockfile
- run: bun run build
- run: bun run package:smoke          # 验证 npm 包完整性
- run: npm publish --provenance --access public  # 先尝试 OIDC 可信发布
  # 失败则回退到 NPM_TOKEN 认证
```

**关键约束：**
- 永远不要手动编辑 `package.json#version`、`CHANGELOG.md`、`.release-please-manifest.json`（release-please 自动管理）
- 禁止手动创建 tag 或 `npm publish`（pipeline 自动处理）
- 每个有用户可见变更的 PR 必须添加 `docs/releases/pending/<slug>.md` 发布说明片段

---

## 2. opencode-swarm 如何与 OpenCode 关联

### OpenCode 的插件系统

OpenCode 支持 v1 插件协议（`readV1Plugin`）。插件本质上是一个 npm 包，默认导出 `{ id, server }` 对象：

```typescript
// src/index.ts 最后几行
export default {
  id: 'opencode-swarm' as const,
  server: OpenCodeSwarm,
} satisfies { id: string; server: Plugin };
```

`server` 是一个 `Plugin` 类型的 async 函数，接收 `ctx`（包含 `directory`、`client` 等上下文），返回 OpenCode 能识别的 manifest（含 agents、tools、hooks、commands 等）。

### 安装与关联过程

#### 方式一：通过 CLI 安装（推荐）

```bash
bunx opencode-swarm install
```

CLI 安装过程（`src/cli/index.ts` 中的 `install()` 函数，约 172-314 行）：

1. **修改 OpenCode 配置文件** `~/.config/opencode/opencode.json`：
   - 在 `plugin` 数组中加入 `"opencode-swarm"`
   - 禁用 OpenCode 默认的 `explore` 和 `general` agent（避免冲突）

2. **创建/更新插件配置** `~/.config/opencode/opencode-swarm.json`（写入默认 agent 配置）

3. **清除 OpenCode 的插件缓存**（`evictPluginCaches()`）：
   - 删除 OpenCode 缓存目录下的旧版本，强制下次启动重新从 npm 拉取最新版本
   - 同时清除 lock 文件（`bun.lock`/`package-lock.json`），强制重新解析依赖

4. **创建项目级配置**：在当前项目 `.opencode/opencode-swarm.json`（可选）

#### 方式二：手动配置

直接在 `opencode.json` 中添加：

```json
{
  "plugin": ["opencode-swarm"]
}
```

### 插件加载流程（OpenCode 启动时）

1. OpenCode 读取 `~/.config/opencode/opencode.json` 中的 `plugin` 数组
2. 对于每个插件名称（如 `"opencode-swarm"`），在插件缓存路径中查找
3. 插件缓存路径（`src/config/cache-paths.ts`）覆盖三大平台：

| 布局 | 路径 | 平台/版本 |
|------|------|-----------|
| **新规范缓存** | `~/.cache/opencode/node_modules/opencode-swarm/` | Linux/macOS, OpenCode v20+ |
| **旧版 XDG 包** | `~/.cache/opencode/packages/opencode-swarm@latest/` | 部分 macOS + Windows |
| **旧版 config** | `~/.config/opencode/node_modules/opencode-swarm/` | OpenCode ≤ v19 |
| **macOS 额外** | `~/Library/Caches/opencode/...` | macOS 变体 |
| **Windows 额外** | `%LOCALAPPDATA%/opencode/...` 等 | Windows 变体 |

4. OpenCode 通过 `bun install` 安装插件到缓存目录，生成 lock 文件
5. OpenCode 调用 `readV1Plugin` 加载 `dist/index.js`，获取 `{ id, server }`
6. 调用 `server(ctx)` 初始化插件，获得 agents、tools、hooks 等

### CLI 作为独立工具

`package.json#bin` 定义了：

```json
"bin": {
  "opencode-swarm": "./dist/cli/index.js"
}
```

支持命令：
- `bunx opencode-swarm install` — 安装并配置
- `bunx opencode-swarm update` — 仅刷新缓存（不修改配置）
- `bunx opencode-swarm uninstall` — 从 OpenCode 移除
- `bunx opencode-swarm run <command>` — 直接在 CLI 中运行插件命令

### 版本更新机制

```bash
bunx opencode-swarm update
# 或
bunx opencode-swarm install   # 重新安装也会触发更新
```

`update()` 函数（约 325-372 行）：
1. 遍历所有已知的插件缓存路径
2. 通过 `evictPluginCaches()` 删除旧版本
3. 通过 `evictLockFiles()` 删除 lock 文件
4. 用户重启 OpenCode 后，OpenCode 检测到缓存不存在/无 lock 文件，重新从 npm 拉取 `@latest`

OpenCode 的 `Npm.add()` 是**缓存优先且无过期检查**的——一旦缓存目录存在，每次启动都会直接返回缓存版本，忽略 npm 上更新的 `@latest`。这正是为什么 `install` 和 `update` 命令必须主动清除缓存，而不能仅仅更新配置。
