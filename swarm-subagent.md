# Swarm Subagent: Independent Context + Completion Notification

## Architecture Overview

In opencode-swarm, each subagent runs in its **own OpenCode session** — a fully isolated LLM context window with its own message history, tool permissions, and lifecycle. The main agent communicates with subagents through the OpenCode **SDK client** (`swarmState.opencodeClient.session`).

The critical APIs (from `src/tools/dispatch-lanes.ts:302-345`):

```
SessionOps:
  create({ body?: { parentID?, title? }, query: { directory } })
    → Promise<{ data?: { id? } }>

  prompt({ path: { id }, body: { agent, tools, parts }, signal? })
    → Promise<{ data?: { parts?: [{ type, text? }] } }>

  promptAsync({ path: { id }, body: { agent, tools, parts }, signal? })
    → Promise<{ data? }>               // non-blocking variant

  messages({ path: { id }, query?: { directory?, limit? } })
    → Promise<{ data?: Array<{ info?: { role? }, parts }> }>

  status({ query?: { directory? } })
    → Promise<{ data?: Record<string, { type? }> }>

  delete({ path: { id } })
    → Promise<unknown>
```

---

## Three Dispatch Patterns

### Pattern 1: Blocking (simplest — wait for result)

Used by the `dispatch_lanes` tool. Creates a session, sends a prompt, waits for the response inline. The subagent's tools are restricted to **read-only** (no write/edit/patch).

```typescript
const session = swarmState.opencodeClient.session;

// 1. Create a fresh session (fully isolated context)
const createResult = await session.create({
  body: {
    parentID: mainSessionId,   // links child to parent in TUI/lifecycle
    title: 'subagent: research-task',
  },
  query: { directory: projectRoot },
});
const subSessionId = createResult.data.id;

// 2. Send prompt — blocks until done
const promptResult = await session.prompt({
  path: { id: subSessionId },
  body: {
    agent: 'explorer',              // which agent to run
    tools: {
      write: false,
      edit: false,
      patch: false,
      save_plan: false,             // deny write tools
      update_task_status: false,
    },
    parts: [{
      type: 'text',
      text: 'Research the codebase for X. Return detailed findings.',
    }],
  },
});

// 3. Extract result
const output = promptResult.data.parts
  .filter(p => p.type === 'text')
  .map(p => p.text)
  .join('\n');

// 4. Clean up
await session.delete({ path: { id: subSessionId } });
```

**Notification**: synchronous — the `await` returns when the subagent finishes. The main agent gets the output in the return value.

---

### Pattern 2: Async with polling (fire-and-forget + collect)

Used by `dispatch_lanes_async` + `collect_lane_results`. The subagent is launched in the background via `queueMicrotask`, and its lifecycle is tracked in `.swarm/background-delegations.jsonl`.

```typescript
const session = swarmState.opencodeClient.session;

// 1. Create session
const createResult = await session.create({
  body: { parentID: mainSessionId, title: 'async-research' },
  query: { directory: projectRoot },
});
const subSessionId = createResult.data.id;

// 2. Record pending state in JSONL ledger
await recordPendingDelegation(directory, {
  correlationId: subSessionId,
  subagentSessionId: subSessionId,
  parentSessionId: mainSessionId,
  agent: 'explorer',
  laneId: 'my-lane',
  batchId: 'my-batch',
});

// 3. Launch via queueMicrotask (non-blocking)
queueMicrotask(async () => {
  try {
    const result = await session.promptAsync({
      path: { id: subSessionId },
      body: {
        agent: 'explorer',
        tools: { write: false, edit: false, patch: false },
        parts: [{ type: 'text', text: '...' }],
      },
    });
    await appendDelegationTransition(directory, {
      correlationId: subSessionId,
      status: 'running',
    });
  } catch (error) {
    await appendDelegationTransition(directory, {
      correlationId: subSessionId,
      status: 'error',
    });
  }
});

// 4. Later — poll for completion
const records = await findByBatchId(directory, 'my-batch');
const settled = records.every(r =>
  ['completed', 'error', 'cancelled'].includes(r.status)
);

// 5. Read result messages
if (settled) {
  const msgs = await session.messages({
    path: { id: subSessionId },
    query: { limit: 50 },
  });
  const transcript = msgs.data
    .filter(m => m.info?.role === 'assistant')
    .flatMap(m => m.parts?.filter(p => p.type === 'text').map(p => p.text) ?? [])
    .join('\n');
}
```

**Notification**: the main agent polls the JSONL ledger OR checks `session.status()` to detect completion.

---

### Pattern 3: Coder subagent with file-write access

Used by Lean Turbo (`src/turbo/lean/runner.ts:710-775`). Same session/prompt pattern but with **write tools enabled**:

```typescript
const result = await session.prompt({
  path: { id: subSessionId },
  body: {
    agent: 'coder',
    tools: {
      write: true,      // coder can modify files
      edit: true,
      patch: true,
    },
    parts: [{ type: 'text', text: `
Implement task 1.1 and 1.2:
- File scope: src/foo.ts, src/bar.ts
- Description: add function calculateTotal()
- Acceptance: passes unit tests
    ` }],
  },
});
```

---

## Context Isolation Guarantees

| Dimension | Isolation Mechanism |
|---|---|
| **LLM context** | Each `session.create()` → unique UUID → independent message history |
| **Tools** | `session.prompt({ body: { tools: {...} } })` — per-call tool deny-list |
| **Directory** | `session.create({ query: { directory } })` — per-session working directory |
| **Agent** | `session.prompt({ body: { agent } })` — which agent definition to use |
| **Lifecycle** | `parentID` links sessions in TUI but does NOT share context |

The subagent sees **none** of the main agent's conversation history. It starts with its own clean system prompt + the provided user text.

---

## Completion Notification — Three Approaches

### A. Synchronous (Pattern 1)
`await session.prompt(...)` returns when done. Simplest for short-lived tasks.

### B. Poll session.status() (Pattern 2)
```typescript
async function waitForSession(sessionId: string, timeoutMs = 300_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await session.status({
      query: { directory: projectRoot },
    });
    const state = status.data?.[sessionId]?.type; // 'idle' = done
    if (state === 'idle') return true;
    await sleep(1000);
  }
  return false; // timeout
}
```

### C. Poll JSONL event ledger (Pattern 2)
The `.swarm/background-delegations.jsonl` file tracks status transitions:
- `pending` → `running` → `completed` / `error` / `cancelled` / `stale`

Each record has `correlationId`, `batchId`, `laneId`, `status`, `createdAt`, `updatedAt`.

Core ledger operations (from `src/background/pending-delegations.ts`):
```typescript
// Write a pending record
function recordPendingDelegation(
  directory: string,
  record: BackgroundDelegationRecord,
): Promise<void>;

// Append a status transition
function appendDelegationTransition(
  directory: string,
  transition: {
    correlationId: string;
    status: RecordStatus;
    result?: { summary?: string; outputRef?: string };
  },
): Promise<void>;

// Read + fold-to-latest per correlationId
function findByBatchId(
  directory: string,
  batchId: string,
  filter?: { excludeConsumed?: boolean },
): BackgroundDelegationRecord[];

// Check if all records in an array are in terminal state
function allSettled(records: BackgroundDelegationRecord[]): boolean;
```

---

## Building a Demo — Step-by-Step

### Demo: "Background Code Analyzer"

The main agent launches a background `explorer` subagent to analyze code, continues working, then collects results when done.

#### 1. Project structure
```
demo-subagent/
├── package.json          // minimal — just "type": "module"
├── src/
│   ├── index.ts          // plugin entry point
│   └── my-tool.ts        // the tool definition
└── tsconfig.json
```

#### 2. Plugin entry (`src/index.ts`)
```typescript
import type { OpenCodePlugin } from 'opencode';
import { myAnalyzeTool } from './my-tool.js';

export default {
  id: 'demo-subagent',
  server: () => ({
    // Register a tool the user can call
    tool: {
      'demo-analyze': myAnalyzeTool,
    },
  }),
} satisfies OpenCodePlugin;
```

#### 3. Tool definition (`src/my-tool.ts`)
```typescript
import { z } from 'zod';

const AnalyzeInputSchema = z.object({
  directory: z.string().describe('Project root directory'),
  target: z.string().describe('What to analyze'),
});

export const myAnalyzeTool = {
  name: 'demo-analyze',
  description: 'Launch a background subagent to analyze code independently',
  inputSchema: {
    target: z.string(),
    directory: z.string(),
  },
  prompt: `Call this when the user asks to analyze code in a subagent.`,
  async execute(input: unknown, context: any) {
    const { directory, target } = AnalyzeInputSchema.parse(input);
    const session = context.client?.session;
    if (!session) return { error: 'No session client available' };

    // --- Create isolated subagent session ---
    const createResult = await session.create({
      body: {
        parentID: context.sessionID,   // link to parent
        title: `subagent-analyze:${target.slice(0, 40)}`,
      },
      query: { directory },
    });
    const subSessionId = createResult.data.id;

    // --- Launch prompt (blocking for simplicity) ---
    const promptResult = await session.prompt({
      path: { id: subSessionId },
      body: {
        agent: 'explorer',
        tools: {
          write: false, edit: false, patch: false,
          save_plan: false, update_task_status: false,
        },
        parts: [{
          type: 'text',
          text: [
            `You are an independent analysis subagent.`,
            `Analyze the project at ${directory} for: ${target}`,
            '',
            'Return your findings in this format:',
            '## Summary',
            '... (2-3 sentences)',
            '## Detailed Findings',
            '- finding 1 with file:line evidence',
            '- finding 2 with file:line evidence',
            '## Recommendations',
            '- recommendation 1',
          ].join('\n'),
        }],
      },
    });

    // --- Extract response ---
    const output = promptResult.data?.parts
      ?.filter((p: any) => p.type === 'text')
      ?.map((p: any) => p.text)
      ?.join('\n') ?? '(no output)';

    // --- Cleanup ---
    await session.delete({ path: { id: subSessionId } }).catch(() => {});

    return {
      summary: `Analysis complete for: ${target}`,
      output,
      subagent_session_id: subSessionId,
    };
  },
};
```

#### 4. Async variant with notification (`src/my-tool.ts` extended)

```typescript
// Record types for the JSONL ledger
interface DelegationRecord {
  correlationId: string;
  subagentSessionId: string;
  parentSessionId: string;
  agent: string;
  status: 'pending' | 'running' | 'completed' | 'error' | 'cancelled';
  createdAt: number;
  updatedAt: number;
  batchId?: string;
  result?: { summary?: string; outputRef?: string };
}

function getLedgerPath(dir: string) {
  return joinPath(dir, '.swarm', 'background-delegations.jsonl');
}

async function appendToLedger(dir: string, record: DelegationRecord) {
  const ledgerPath = getLedgerPath(dir);
  const line = JSON.stringify(record) + '\n';
  await appendFile(ledgerPath, line, 'utf-8');
}

async function readLedger(dir: string): Promise<DelegationRecord[]> {
  const ledgerPath = getLedgerPath(dir);
  const content = await readFile(ledgerPath, 'utf-8').catch(() => '');
  const folded = new Map<string, DelegationRecord>();
  for (const line of content.trim().split('\n')) {
    try {
      const record = JSON.parse(line) as DelegationRecord;
      folded.set(record.correlationId, record);  // fold to latest
    } catch { continue; }
  }
  return [...folded.values()];
}

export const myAsyncAnalyzeTool = {
  name: 'demo-analyze-async',
  description: 'Launch a background subagent and return immediately',
  inputSchema: {
    target: z.string(),
    directory: z.string(),
  },
  async execute(input: unknown, context: any) {
    const { directory, target } = AnalyzeInputSchema.parse(input);
    const session = context.client?.session;
    if (!session) return { error: 'No session client available' };

    // Create session
    const createResult = await session.create({
      body: {
        parentID: context.sessionID,
        title: `async-analyze:${target.slice(0, 40)}`,
      },
      query: { directory },
    });
    const subSessionId = createResult.data.id;

    // Record pending
    const batchId = `batch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await appendToLedger(directory, {
      correlationId: subSessionId,
      subagentSessionId: subSessionId,
      parentSessionId: context.sessionID,
      agent: 'explorer',
      status: 'pending',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      batchId,
    });

    // Launch async (non-blocking)
    queueMicrotask(async () => {
      try {
        await session.prompt({
          path: { id: subSessionId },
          body: {
            agent: 'explorer',
            tools: { write: false, edit: false, patch: false },
            parts: [{ type: 'text', text: `Analyze ${target} in ${directory}` }],
          },
        });
        await appendToLedger(directory, {
          correlationId: subSessionId,
          subagentSessionId: subSessionId,
          parentSessionId: context.sessionID,
          agent: 'explorer',
          status: 'completed',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          batchId,
          result: { summary: `Analysis of ${target} complete` },
        });
      } catch (e) {
        await appendToLedger(directory, {
          correlationId: subSessionId,
          subagentSessionId: subSessionId,
          parentSessionId: context.sessionID,
          agent: 'explorer',
          status: 'error',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          batchId,
          result: { summary: String(e) },
        });
      }
    });

    return {
      message: `Launched background analysis for: ${target}`,
      batch_id: batchId,
      check_tool: 'demo-collect-results',
    };
  },
};

// Tool to collect results
export const collectResultsTool = {
  name: 'demo-collect-results',
  description: 'Check if background analysis is done',
  inputSchema: { batch_id: z.string(), directory: z.string() },
  async execute(input: unknown, context: any) {
    const { batch_id, directory } = AnalyzeInputSchema.extend({
      batch_id: z.string(),
    }).parse(input);

    const records = (await readLedger(directory))
      .filter(r => r.batchId === batch_id);

    // If completed, fetch the session messages
    const completedRecords = records.filter(r => r.status === 'completed');
    if (completedRecords.length > 0) {
      const session = context.client?.session;
      const msgs = await session?.messages({
        path: { id: completedRecords[0].subagentSessionId },
        query: { limit: 50 },
      });
      const text = msgs?.data
        ?.filter(m => m.info?.role === 'assistant')
        ?.flatMap(m =>
          m.parts?.filter(p => p.type === 'text').map(p => p.text) ?? []
        )
        ?.join('\n') ?? '(empty)';

      // Cleanup
      await session?.delete({
        path: { id: completedRecords[0].subagentSessionId },
      }).catch(() => {});

      return { status: 'completed', output: text };
    }

    const pending = records.filter(r =>
      r.status === 'pending' || r.status === 'running'
    );
    if (pending.length > 0) {
      return { status: 'running', message: 'Background analysis still in progress' };
    }

    return { status: 'not_found', message: 'No records found for this batch' };
  },
};
```

---

## Key Source Files Reference

| File | Purpose |
|---|---|
| `src/tools/dispatch-lanes.ts` | Core dispatch: `runLane()`, `launchAsyncLane()`, `collectOnce()` |
| `src/background/pending-delegations.ts` | JSONL event ledger: write, read, fold-to-latest, sweep |
| `src/background/lane-output-store.ts` | Content-addressable output storage under `.swarm/lane-results/` |
| `src/parallel/dispatcher/parallel-dispatcher.ts` | Concurrency guard (p-limit + slot map) |
| `src/state.ts` | `swarmState.opencodeClient` — the SDK entry point |
| `src/full-auto/oversight.ts` | Ephemeral session example with `finally` cleanup |
| `src/turbo/lean/runner.ts` | Coder subagent with worktree isolation |

---

## Invariant Checklist for New Demos

Before committing a new subagent dispatch path:

- [ ] **Session lifecycle**: every `session.create()` has a matching `session.delete()` or `scheduleSessionCleanup()`
- [ ] **Error handling**: `prompt()` errors logged non-fatally; `delete()` in `finally` or `.catch()`
- [ ] **Timeout**: wrap `session.prompt()` in `withTimeout()` or `AbortController`
- [ ] **Tool permissions**: explicitly deny write tools (`write: false, edit: false, patch: false`)
- [ ] **Context isolation**: use `parentID` for TUI linking only — never share message history
- [ ] **Notification path**: blocking `await`, status polling, or JSONL ledger — choose one and make it explicit
- [ ] **Portal path**: use `SessionOps` interface (not raw SDK) for testability
