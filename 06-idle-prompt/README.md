# Idle-Prompt Plugin

Detects when OpenCode is **truly idle** and automatically sends `hello` to the current session. Ensures that a new `hello` is only sent after the previous reply has been fully processed.

## Design: ExecutionTracker + Hello Lock

Built on the same composite state machine as `05-idle-check-plugin`, adding a `helloLocked` flag and blocking `prompt()` call for **guaranteed reply completion**.

```
TRUE_IDLE + !helloLocked
  → sendHello("hello") → helloLocked = true
  → client.session.prompt() blocks until AI fully replies
  → helloLocked = false
  → next TRUE_IDLE sends another hello
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

## Uninstall

```bash
bash clean.sh
```
