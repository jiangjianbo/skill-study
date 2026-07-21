# Idle-Prompt Plugin

Detects when OpenCode is **truly idle** and automatically sends `hello` to the current session. Ensures that a new `hello` is only sent after the previous reply has been fully processed.

## Design: OpenCodeTrueIdleDetector + Hello Lock

`OpenCodeTrueIdleDetector` 是独立的可复用类（`src/opencode-true-idle-detector.js`），封装了复合状态机 + 200ms 基础去抖 + **指数退避持续检测**。通过 `onIdle` 异步回调通知消费方。

```
OpenCodeTrueIdleDetector.handleEvent(event)
  → 状态机判定 + 去抖（200ms 起，TRUE_IDLE 后翻倍）
  → TRUE_IDLE → onIdle(sessionID) 异步回调 + 递归 reschedule
```

消费方在回调中管理 `helloLocked` 锁：

```
onIdle(sessionID)
  ├── helloLocked == true → SKIP
  └── helloLocked == false → sendHello → prompt() 阻塞 → 解锁
```

| Signal | False Positives |
|--------|----------------|
| `session.idle` | ~10x/action |
| `session.status=idle` | same |
| **ExecutionTracker** | near 0 |

## Install

```bash
npm install
```

Then **restart opencode**.

Check logs: `tail -f .log/log-*.log`

Expected output:
```
[INIT] Plugin initialized
[TRUE_IDLE] session=xxx status=idle perm=off quest=off
[HELLO] session=xxx count=1 sending hello
[HELLO_DONE] session=xxx count=1 reply complete
[TRUE_IDLE] session=xxx status=idle perm=off quest=off
[HELLO] session=xxx count=2 sending hello
```

Note: `TRUE_IDLE` checks use exponential backoff (200ms → 400ms → 800ms...). User input resets detector state and backoff timer.

## Uninstall

```bash
bash clean.sh
```
