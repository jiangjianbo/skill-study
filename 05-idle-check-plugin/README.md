# Idle-Check Plugin

Detects when OpenCode is **truly idle** — AI has completely finished a response cycle, not just paused between steps.

## Design: ExecutionTracker

Instead of listening to `session.idle` (fires ~10x per action), the plugin maintains a **composite state machine**:

```
ExecutionTracker {
  status: 'idle' | 'busy'
  waitingPermission: boolean
  waitingQuestion: boolean
}
```

### Detection Algorithm

```
session.status → idle
  ├── waitingPermission? → NOT idle
  ├── waitingQuestion? → NOT idle
  └── both clear → 200ms debounce
                    ├── new busy? → cancel
                    └── no busy → TRUE_IDLE ✓
```

### Why Composite?

| Signal | False Positives |
|--------|----------------|
| `session.idle` | ~10x/action |
| `session.status=idle` | same |
| `permission.asked` → status stays `busy` | miss! |
| **ExecutionTracker** | near 0 |

## Structure

```
05-idle-check-plugin/
├── src/
│   └── index.js              ← Plugin source
├── scripts/
│   └── postinstall.js         ← npm postinstall: copies src/ → .opencode/
├── package.json               ← postinstall + @opencode-ai/plugin dep
├── clean.sh                   ← remove installed files
├── .gitignore
├── .opencode/                  ← auto-generated at install time
│   ├── opencode.json           ← plugin config (postinstall writes this)
│   └── plugins/idle-check/src/index.js  ← deployed plugin
└── .log/                       ← runtime logs (project root)
```

## Install

```bash
npm install
```

This installs `@opencode-ai/plugin`, then `postinstall` runs automatically:
1. Copies `src/index.js` → `.opencode/plugins/idle-check/src/index.js`
2. Updates `.opencode/opencode.json` with plugin reference

## Post-Install

**Restart opencode** to load the plugin.

Check logs: `tail -f .log/log-*.log`

Expected output:
```
[2026-07-20T12:00:00.000Z] [INIT] Plugin initialized
[2026-07-20T12:00:15.200Z] [TRUE_IDLE] session=xxx status=idle perm=off quest=off
```

## Uninstall

```bash
bash clean.sh
```

Removes `.opencode/plugins/idle-check/` and `.log/`.

## Log Format

All logs at `.log/log-<YYYYMMDD-HHmmss>.log` with ISO 8601 timestamps:

| Level | Meaning |
|-------|---------|
| `INIT` | Plugin started |
| `STATUS` | Session status change |
| `TRUE_IDLE` | **True idle detected** |
| `PERM` | Permission state |
| `QUEST` | Question state |
| `DEBOUNCE` | Idle cancelled by new activity |
| `USER_INPUT` | User chat message |
| `AI_REPLY` | AI reply message |
| `DISPOSE` | Plugin shutting down |
