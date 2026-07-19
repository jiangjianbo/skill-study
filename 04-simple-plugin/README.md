# 04-simple-plugin

opencode 插件示例项目——挂接所有 hook 并将日志输出到文件。

## 项目结构

```
04-simple-plugin/
├── package.json               # npm 包配置，main 指向 src/index.js
├── clean.sh                   # 清理脚本，删除 .opencode 下的已部署插件
├── src/
│   ├── index.js               # 插件主入口，导出 PluginModule（id + server）
│   └── logger.js              # 日志工具，写入 .log/log-时间戳.log
├── scripts/
│   └── postinstall.js         # 安装后部署脚本，复制文件到 .opencode/plugins/
├── .log/                      # 日志输出目录（自动创建，已 gitignore）
└── .opencode/
    ├── opencode.json          # 项目级 opencode 配置，plugin 数组引用本地插件
    └── plugins/
        └── 04-simple-plugin/
            ├── package.json   # 部署副本
            └── src/index.js   # 部署副本
```

- `src/index.js` — 插件源码，`server()` 返回包含所有 Hooks 的对象，每项 hook 通过 `src/logger.js` 输出日志
- `src/logger.js` — 日志工具，自动在 `.log/` 目录下创建 `log-YYYYMMDD-HHmmss.log` 文件，每行带 ISO 时间戳
- `clean.sh` — 清理脚本，删除 `.opencode/plugins/04-simple-plugin/` 目录
- `scripts/postinstall.js` — 在 `npm install` 后自动将插件部署到 `.opencode/plugins/`，并更新 `.opencode/opencode.json`
- `.opencode/opencode.json` — 项目级配置，通过 `plugin: ["./plugins/04-simple-plugin/src/index.js"]` 加载本地插件

## 安装

```bash
npm install
```

`postinstall` 钩子会自动将插件部署到 `.opencode/plugins/04-simple-plugin/`。

## 使用

安装并启动 opencode 后，插件会自动加载。所有 hook 被触发时会写入日志文件。

查看日志：

```bash
# 日志文件位于 .log/ 目录下
ls .log/
cat .log/log-20260719-143022.log

# 每行格式：[ISO时间戳] [04-simple-plugin] hook名称 { ...数据... }
# 示例输出：
# [2026-07-19T06:30:22.123Z] [04-simple-plugin] chat.params {"sessionID":"...","agent":"coder",...}
# [2026-07-19T06:30:23.456Z] [04-simple-plugin] tool.execute.before {"tool":"read",...}
```

## 支持的全部 Hook

| Hook | 说明 |
|------|------|
| `dispose` | 插件卸载时 |
| `event` | 事件通知 |
| `config` | 配置变更 |
| `chat.message` | 收到聊天消息 |
| `chat.params` | 修改 LLM 调用参数 |
| `chat.headers` | 修改 LLM 请求头 |
| `permission.ask` | 权限询问 |
| `command.execute.before` | 命令执行前 |
| `tool.execute.before` | 工具执行前 |
| `shell.env` | Shell 环境变量注入 |
| `tool.execute.after` | 工具执行后 |
| `experimental.chat.messages.transform` | 消息变换 |
| `experimental.chat.system.transform` | 系统提示变换 |
| `experimental.provider.small_model` | 小模型回退 |
| `experimental.session.compacting` | Session 压缩 |
| `experimental.compaction.autocontinue` | 压缩后自动继续 |
| `experimental.text.complete` | 文本补全 |
| `tool.definition` | 工具定义修改 |

## 清理

```bash
./clean.sh
```

## 重新部署

```bash
node scripts/postinstall.js
```

或先清理再重新 `npm install`。
