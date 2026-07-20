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

  const helloState = {
    locked: false,
    count: 0,
  };

  async function sendHello(sessionID) {
    helloState.locked = true;
    helloState.count++;
    log('HELLO', `session=${sessionID} count=${helloState.count} sending hello`);
    try {
      await client.session.prompt({
        path: { id: sessionID },
        body: {
          parts: [{ type: 'text', text: 'hello' }],
        },
      });
      log('HELLO_DONE', `session=${sessionID} count=${helloState.count} reply complete`);
    } catch (err) {
      log('HELLO_ERR', `session=${sessionID} count=${helloState.count} ${err.message}`);
    }
    helloState.locked = false;
  }

  const detector = new OpenCodeTrueIdleDetector({
    log,
    onIdle: async (sessionID) => {
      if (!helloState.locked) {
        await sendHello(sessionID);
      }
    },
  });

  log('INIT', `Plugin initialized | directory=${directory}`);
  log('DESIGN', 'Idle-Prompt: idle detection + auto hello + repeat guard');
  log('DESIGN', JSON.stringify({
    signals: ['session.status', 'session.idle', 'permission.asked', 'question.asked'],
    rule: 'TRUE_IDLE -> onIdle callback -> send hello (blocking prompt, unlocks on reply)',
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
        helloState.locked = false;
        helloState.count = 0;
        log('USER_INPUT', `session=${sessionID} msg=${messageID} model=${modelStr} len=${textContent.length} text=${JSON.stringify(entry)}`);
      } else if (role === 'assistant') {
        log('AI_REPLY', `session=${sessionID} msg=${messageID} model=${modelStr} len=${textContent.length} text=${JSON.stringify(entry)}`);
      }
    },

    dispose: async () => {
      log('DISPOSE', 'Plugin shutting down');
      detector.dispose();
    },
  };
};

export default {
  id: 'idle-prompt',
  server,
};
