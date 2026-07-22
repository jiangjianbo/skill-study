import fs from 'node:fs';
import path from 'node:path';
import { OpenCodeTrueIdleDetector } from './opencode-true-idle-detector.js';
import { SubagentTrigger } from './subagent-trigger.js';

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

const TRIGGER_DELAY_MS = 60_000;
const SUBAGENT_AGENT_TYPE = 'explore';
const SUBAGENT_PROMPT = 'Hello! 请简短地打个招呼并自我介绍一下。';

const server = async (input) => {
  const { directory, client } = input;
  const logDir = path.join(directory, '.log');
  const log = createLogger(logDir);

  let mainSessionID = null;
  let pendingTimer = null;

  function cancelPendingTimer(sessionID) {
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
      log('CANCEL', `session=${sessionID} cancelled scheduled trigger`);
    }
  }

  const detector = new OpenCodeTrueIdleDetector({
    log,
    onIdle: async (sessionID) => {
      if (!mainSessionID) mainSessionID = sessionID;
      if (sessionID !== mainSessionID) {
        log('SKIP', `session=${sessionID} not main session`);
        return;
      }
      if (trigger.inFlight) {
        log('SKIP', `session=${sessionID} trigger in flight`);
        return;
      }
      if (pendingTimer) {
        log('SKIP', `session=${sessionID} trigger already scheduled`);
        return;
      }
      pendingTimer = setTimeout(() => {
        pendingTimer = null;
        trigger.trigger(sessionID, {
          agentType: SUBAGENT_AGENT_TYPE,
          prompt: SUBAGENT_PROMPT,
        });
      }, TRIGGER_DELAY_MS);
      log('SCHEDULE', `session=${sessionID} trigger scheduled in ${TRIGGER_DELAY_MS}ms`);
    },
    onIdleExit: (sessionID) => {
      if (mainSessionID && sessionID !== mainSessionID) return;
      cancelPendingTimer(sessionID);
    },
    onUserInterrupt: (sessionID) => {
      if (mainSessionID && sessionID !== mainSessionID) return;
      cancelPendingTimer(sessionID);
      log('INTERRUPT', `session=${sessionID} user interrupt`);
    },
    onUserInput: (sessionID) => {
      if (mainSessionID && sessionID !== mainSessionID) return;
      cancelPendingTimer(sessionID);
    },
  });

  const trigger = new SubagentTrigger({ client, detector, log, directory });

  log('INIT', 'Plugin initialized');
  log('DESIGN', 'Subagent: idle detection -> 60s wait -> prompt main session (skip user input detection) -> agent calls Task tool');
  log('DESIGN', `agentType=${SUBAGENT_AGENT_TYPE} delay=${TRIGGER_DELAY_MS}ms`);
  log('DESIGN', JSON.stringify({
    mechanism: 'agent-driven Task tool with skipNextUserMessage flag',
    signals: ['session.status', 'session.idle', 'permission.asked', 'question.asked'],
    rule: 'TRUE_IDLE -> wait 60s -> session.prompt (skip detection) -> agent calls Task(explore) -> host renders link',
  }));

  return {
    event: async (input) => {
      detector.handleEvent(input);
      return;
    },

    'chat.message': async (input, output) => {
      const { sessionID, messageID, model } = input;
      const { message, parts } = output;
      const role = message?.role || 'unknown';
      const textContent = parts?.map((p) => p.text).filter(Boolean).join('\n');
      const modelStr = model ? `${model.providerID}/${model.modelID}` : '';
      const entry = textContent.slice(0, 2000);

      if (role === 'user') {
        log('USER_INPUT', `session=${sessionID} msg=${messageID} model=${modelStr} len=${textContent.length} text=${JSON.stringify(entry)}`);
      } else if (role === 'assistant') {
        log('AI_REPLY', `session=${sessionID} msg=${messageID} model=${modelStr} len=${textContent.length} text=${JSON.stringify(entry)}`);
      }

      detector.handleChatMessage(input, output);
    },

    dispose: async () => {
      log('DISPOSE', 'Plugin shutting down');
      cancelPendingTimer('dispose');
      detector.dispose();
    },
  };
};

export default {
  id: 'subagent-hello',
  server,
};
