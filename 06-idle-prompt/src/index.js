import fs from 'node:fs';
import path from 'node:path';

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

  const t = {
    status: 'idle',
    waitingPermission: false,
    waitingQuestion: false,
    helloLocked: false,
    helloCount: 0,
    activeSessionID: null,
    pendingCheck: null,
  };

  function scheduleCheck(sessionID, delay = 200) {
    if (t.pendingCheck) clearTimeout(t.pendingCheck);
    t.pendingCheck = setTimeout(() => {
      t.pendingCheck = null;
      const trueIdle = t.status === 'idle' && !t.waitingPermission && !t.waitingQuestion;
      if (trueIdle) {
        log('TRUE_IDLE', `session=${sessionID} status=idle perm=off quest=off helloLocked=${t.helloLocked}`);
        if (!t.helloLocked && t.activeSessionID) {
          sendHello(t.activeSessionID);
        }
      } else {
        log('SKIP', `session=${sessionID} not true idle: status=${t.status} perm=${t.waitingPermission} quest=${t.waitingQuestion}`);
      }
    }, delay);
  }

  async function sendHello(sessionID) {
    t.helloLocked = true;
    t.helloCount++;
    log('HELLO', `session=${sessionID} count=${t.helloCount} sending hello`);
    try {
      await client.session.prompt({
        path: { id: sessionID },
        body: {
          parts: [{ type: 'text', text: 'hello' }],
        },
      });
      log('HELLO_DONE', `session=${sessionID} count=${t.helloCount} reply complete`);
    } catch (err) {
      log('HELLO_ERR', `session=${sessionID} count=${t.helloCount} ${err.message}`);
    }
    t.helloLocked = false;
  }

  log('INIT', `Plugin initialized | directory=${directory}`);
  log('DESIGN', 'Idle-Prompt: idle detection + auto hello + repeat guard');
  log('DESIGN', JSON.stringify({
    signals: ['session.status', 'session.idle', 'permission.asked', 'question.asked'],
    rule: 'TRUE_IDLE -> send hello (blocking prompt, unlocks on reply)',
  }));

  return {
    event: async ({ event }) => {
      const { type, properties = {} } = event;
      const sid = properties.sessionID || properties.info?.id || '-';

      switch (type) {
        case 'session.status': {
          const s = properties.status;
          if (!s || !s.type) break;
          const oldStatus = t.status;
          t.status = s.type;
          log('STATUS', `session=${sid} ${oldStatus} -> ${s.type}`);
          if (s.type === 'idle' && !t.waitingPermission && !t.waitingQuestion) {
            log('CANDIDATE', `session=${sid} idle, scheduling check`);
            scheduleCheck(sid, 200);
          }
          if (s.type === 'busy' && t.pendingCheck) {
            clearTimeout(t.pendingCheck);
            t.pendingCheck = null;
            log('DEBOUNCE', `session=${sid} cancelled (new busy)`);
          }
          break;
        }
        case 'session.idle': {
          t.activeSessionID = sid;
          log('IDLE', `session=${sid}`);
          break;
        }
        case 'permission.asked': {
          t.waitingPermission = true;
          log('PERM', `session=${sid} WAITING action=${properties.action}`);
          break;
        }
        case 'permission.replied': {
          t.waitingPermission = false;
          log('PERM', `session=${sid} RESOLVED reply=${properties.reply}`);
          if (t.status === 'idle') scheduleCheck(sid, 200);
          break;
        }
        case 'question.asked': {
          t.waitingQuestion = true;
          log('QUEST', `session=${sid} WAITING`);
          break;
        }
        case 'question.replied2':
        case 'question.rejected2': {
          t.waitingQuestion = false;
          log('QUEST', `session=${sid} RESOLVED`);
          if (t.status === 'idle') scheduleCheck(sid, 200);
          break;
        }
      }
    },

    "chat.message": async (input, output) => {
      const { sessionID, messageID, model } = input;
      const { message, parts } = output;
      const role = message?.role || 'unknown';
      const textContent = parts?.map(p => p.text).filter(Boolean).join('\n');
      const modelStr = model ? `${model.providerID}/${model.modelID}` : '';
      const entry = textContent.slice(0, 2000);

      if (role === 'user') {
        t.helloLocked = false;
        t.helloCount = 0;
        log('USER_INPUT', `session=${sessionID} msg=${messageID} model=${modelStr} len=${textContent.length} text=${JSON.stringify(entry)}`);
      } else if (role === 'assistant') {
        log('AI_REPLY', `session=${sessionID} msg=${messageID} model=${modelStr} len=${textContent.length} text=${JSON.stringify(entry)}`);
      }
    },

    dispose: async () => {
      log('DISPOSE', 'Plugin shutting down');
      if (t.pendingCheck) clearTimeout(t.pendingCheck);
    },
  };
};

export default {
  id: 'idle-prompt',
  server,
};
