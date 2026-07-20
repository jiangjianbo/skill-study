import fs from 'node:fs';
import path from 'node:path';
import { OpenCodeTrueIdleDetector } from './opencode-true-idle-detector.js';

function createLogger(logDir) {
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }
  const now = new Date();
  const ts = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
  const logPath = path.join(logDir, `log-${ts}.log`);
  return (level, msg) => {
    const t = new Date().toISOString();
    fs.appendFileSync(logPath, `[${t}] [${level}] ${msg}\n`);
  };
}

const server = async (input) => {
  const { directory, client } = input;
  const logDir = path.join(directory, '.log');
  const log = createLogger(logDir);

  const subagentState = {
    pendingTimer: null,
    running: false,
    count: 0,
  };

  async function launchSubagent(sessionID) {
    subagentState.running = true;
    subagentState.count++;
    log('SUBAGENT', `session=${sessionID} count=${subagentState.count} launching subagent`);

    let subSessionId = null;
    try {
      const createResult = await client.session.create({
        body: {
          parentID: sessionID,
          title: `subagent-hello-${subagentState.count}`,
        },
        query: { directory },
      });
      subSessionId = createResult.data.id;
      log('SUBAGENT_CREATED', `session=${sessionID} subSessionId=${subSessionId}`);

      const promptResult = await client.session.prompt({
        path: { id: subSessionId },
        body: {
          agent: 'explorer',
          tools: {
            write: false,
            edit: false,
            patch: false,
            save_plan: false,
            update_task_status: false,
          },
          parts: [{
            type: 'text',
            text: 'Hello! Please respond with a simple greeting and a short introduction of yourself.',
          }],
        },
      });

      const output = promptResult.data?.parts
        ?.filter((p) => p.type === 'text')
        ?.map((p) => p.text)
        ?.join('\n') ?? '(no output)';

      log('SUBAGENT_DONE', `session=${sessionID} subSessionId=${subSessionId} count=${subagentState.count} output=${JSON.stringify(output.slice(0, 500))}`);
    } catch (err) {
      log('SUBAGENT_ERR', `session=${sessionID} subSessionId=${subSessionId} count=${subagentState.count} ${err.message}`);
    }

    if (subSessionId) {
      await client.session.delete({ path: { id: subSessionId } }).catch(() => {});
      log('SUBAGENT_CLEANUP', `session=${sessionID} subSessionId=${subSessionId} deleted`);
    }

    subagentState.running = false;
  }

  const detector = new OpenCodeTrueIdleDetector({
    log,
    onIdle: async (sessionID) => {
      if (subagentState.running) {
        log('SKIP', `session=${sessionID} subagent already running, skipping`);
        return;
      }
      subagentState.pendingTimer = setTimeout(() => {
        subagentState.pendingTimer = null;
        launchSubagent(sessionID);
      }, 60_000);
      log('SCHEDULE', `session=${sessionID} subagent scheduled in 60s`);
    },
  });

  log('INIT', 'Plugin initialized');
  log('DESIGN', 'Subagent: idle detection -> 1min wait -> async subagent -> wait completion');
  log('DESIGN', JSON.stringify({
    signals: ['session.status', 'session.idle', 'permission.asked', 'question.asked'],
    rule: 'TRUE_IDLE -> wait 60s -> create child session -> prompt explorer(subagent) "hello" -> wait reply -> cleanup',
  }));

  return {
    event: async (input) => { detector.handleEvent(input); return; },

    "chat.message": async (input, output) => {
      const { sessionID, messageID, model } = input;
      const { message, parts } = output;
      const role = message?.role || 'unknown';
      const textContent = parts?.map(p => p.text).filter(Boolean).join('\n');
      const modelStr = model ? `${model.providerID}/${model.modelID}` : '';
      const entry = textContent.slice(0, 2000);

      if (role === 'user') {
        if (subagentState.pendingTimer) {
          clearTimeout(subagentState.pendingTimer);
          subagentState.pendingTimer = null;
          log('CANCEL', `session=${sessionID} cancelled scheduled subagent (user input)`);
        }
        log('USER_INPUT', `session=${sessionID} msg=${messageID} model=${modelStr} len=${textContent.length} text=${JSON.stringify(entry)}`);
      } else if (role === 'assistant') {
        log('AI_REPLY', `session=${sessionID} msg=${messageID} model=${modelStr} len=${textContent.length} text=${JSON.stringify(entry)}`);
      }
    },

    dispose: async () => {
      log('DISPOSE', 'Plugin shutting down');
      if (subagentState.pendingTimer) {
        clearTimeout(subagentState.pendingTimer);
        subagentState.pendingTimer = null;
      }
      detector.dispose();
    },
  };
};

export default {
  id: 'subagent-hello',
  server,
};
