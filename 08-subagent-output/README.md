# subagent-hello

OpenCode 插件：检测到主会话真正空闲 60 秒后，自动触发子代理打招呼。

## 工作原理

```
空闲检测 (TRUE_IDLE) → 等待 60s → 插件直接调用 Task 工具
                                           ↓
                                 宿主自动创建子会话
                                 渲染可点击 <task> 链接
                                 保存完整消息历史
                                           ↓
                                 用户点击链接查看子代理输出
```

插件通过 **`client.tool.call()` 直接调用内置 Task 工具**，由 OpenCode 宿主接管全部生命周期。

## 安装

```bash
npm install
```

然后重启 opencode。

## 验证

```bash
tail -f .log/log-*.log
```

等待主会话空闲 60 秒后，日志中应出现 `TRIGGER` → `TRIGGER_DONE`，主会话中出现可点击的子代理链接。

## 卸载

```bash
bash clean.sh
```

## 配置

在 `src/index.js` 顶部修改：

| 常量 | 默认值 | 说明 |
|------|--------|------|
| `TRIGGER_DELAY_MS` | `60_000` | 空闲后等待时间 |
| `SUBAGENT_AGENT_TYPE` | `'explore'` | 子代理类型 |
| `SUBAGENT_PROMPT` | `'Hello! ...'` | 子代理 prompt |

## 文件结构

| 文件 | 说明 |
|------|------|
| `src/index.js` | 插件入口，组装检测器 + 触发器 |
| `src/opencode-true-idle-detector.js` | 空闲检测状态机 |
| `src/subagent-trigger.js` | 子代理触发器（可复用） |
| `scripts/postinstall.js` | 部署脚本 |
