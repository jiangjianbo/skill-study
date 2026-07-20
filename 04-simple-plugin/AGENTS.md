# 04-simple-plugin

opencode 插件示例项目，挂接所有 hook 并将日志输出到 `.log/` 目录。

## 项目结构

```
04-simple-plugin/
├── src/
│   ├── index.js          # 主入口，导出 { id, server }
│   └── logger.js         # createLogger(logDir) 工厂，写入 .log/log-时间戳.log
├── scripts/
│   └── postinstall.js    # npm postinstall：复制文件到 .opencode/plugins/ 并更新配置
├── package.json
├── clean.sh              # 删除 .opencode/plugins/04-simple-plugin/
└── .log/                 # 日志输出目录（已 gitignore，运行时自动创建）
```

## 关键文件说明

- `src/index.js` — `server(input)` 返回包含所有 hook 的对象，用 `input.directory` 拼接 `.log/` 路径创建 logger
- `src/logger.js` — 导出 `createLogger(logDir)` 工厂，生成 `log-YYYYMMDD-HHmmss.log` 文件，每行 `[ISO时间戳] ...`
- `scripts/postinstall.js` — 将 `package.json` 和 `src/` 复制到 `.opencode/plugins/04-simple-plugin/`，并写入 `.opencode/opencode.json`

## 支持的全部 Hook

| Hook | 说明 |
|------|------|
| `dispose` | 插件卸载 |
| `event` | 事件通知 |
| `config` | 配置变更 |
| `chat.message` | 聊天消息 |
| `chat.params` | LLM 调用参数 |
| `chat.headers` | LLM 请求头 |
| `permission.ask` | 权限询问 |
| `command.execute.before` | 命令执行前 |
| `tool.execute.before` | 工具执行前 |
| `shell.env` | Shell 环境变量 |
| `tool.execute.after` | 工具执行后 |
| `experimental.chat.messages.transform` | 消息变换 |
| `experimental.chat.system.transform` | 系统提示变换 |
| `experimental.provider.small_model` | 小模型回退 |
| `experimental.session.compacting` | Session 压缩 |
| `experimental.compaction.autocontinue` | 压缩自动继续 |
| `experimental.text.complete` | 文本补全 |
| `tool.definition` | 工具定义修改 |

## 命令

| 命令 | 说明 |
|------|------|
| `npm install` | 安装依赖 + postinstall 自动部署 |
| `node scripts/postinstall.js` | 手动重新部署 |
| `bash clean.sh` | 删除已部署插件 |
| `ls .log/` | 查看日志文件 |
| `tail -f .log/log-*.log` | 实时跟踪日志 |

## 规范

- 使用 ESM (`type: "module"`)
- `index.js` 在 `server()` 内部创建 logger，用 `input.directory` 定位 `.log/`
- 所有 hook handler 格式：`"hook.name": async (input, output) => { ... }`
- 日志统一走 `createLogger`，不直接 `console.log` 或写文件
- 代码不加注释
