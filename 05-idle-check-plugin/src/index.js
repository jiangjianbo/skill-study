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
  const { directory } = input;
  const logDir = path.join(directory, '.log');
  const log = createLogger(logDir);

  const BASE_DELAY = 200;
  let currentDelay = BASE_DELAY;

  const t = {
    status: 'idle',
    waitingPermission: false,
    waitingQuestion: false,
    idleSince: null,
    pendingCheck: null,
  };

  function resetIdleState(sessionID) {
    if (t.pendingCheck) {
      clearTimeout(t.pendingCheck);
      t.pendingCheck = null;
    }
    t.waitingPermission = false;
    t.waitingQuestion = false;
    t.status = 'busy';
    currentDelay = BASE_DELAY;
    log('RESET', `session=${sessionID} state reset on user input`);
  }

  function scheduleCheck(sessionID, delay) {
    const d = delay ?? currentDelay;
    if (t.pendingCheck) clearTimeout(t.pendingCheck);
    t.pendingCheck = setTimeout(() => {
      const trueIdle = t.status === 'idle' && !t.waitingPermission && !t.waitingQuestion;
      if (trueIdle) {
        log('TRUE_IDLE', `session=${sessionID} status=idle perm=off quest=off delay=${d}`);
        currentDelay *= 2;
        scheduleCheck(sessionID);
      } else {
        log('SKIP', `session=${sessionID} not true idle: status=${t.status} perm=${t.waitingPermission} quest=${t.waitingQuestion}`);
        t.pendingCheck = null;
      }
    }, d);
  }

  log('INIT', `Plugin initialized | directory=${directory}`);
  log('DESIGN', 'ExecutionTracker composite state machine for true idle detection');
  log('DESIGN', JSON.stringify({
    signals: ['session.status', 'session.idle', 'permission.asked', 'question.asked'],
    rule: 'TRUE_IDLE = status==idle && !perm && !quest (debounced 200ms)',
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
            scheduleCheck(sid);
          }
          if (s.type === 'busy' && t.pendingCheck) {
            clearTimeout(t.pendingCheck);
            t.pendingCheck = null;
            log('DEBOUNCE', `session=${sid} cancelled (new busy)`);
          }
          break;
        }
        case 'session.idle': {
          t.idleSince = Date.now();
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
      log(role === 'user' ? 'USER_INPUT' : 'AI_REPLY', `session=${sessionID} msg=${messageID} model=${modelStr} len=${textContent.length} text=${JSON.stringify(entry)}`);
      if (role === 'user') {
        resetIdleState(sessionID);
      }
    },

    dispose: async () => {
      log('DISPOSE', 'Plugin shutting down');
      if (t.pendingCheck) clearTimeout(t.pendingCheck);
    },
  };
};

export default {
  id: 'idle-check',
  server,
};
