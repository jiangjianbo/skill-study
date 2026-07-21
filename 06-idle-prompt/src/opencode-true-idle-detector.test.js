import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpenCodeTrueIdleDetector } from './opencode-true-idle-detector.js';

function createDetector(opts = {}) {
  const log = opts.log ?? vi.fn();
  const onIdle = opts.onIdle ?? vi.fn();
  const onIdleExit = opts.onIdleExit ?? vi.fn();
  const onUserInterrupt = opts.onUserInterrupt ?? vi.fn();
  const onUserInput = opts.onUserInput ?? vi.fn();
  const detector = new OpenCodeTrueIdleDetector({
    log, onIdle, onIdleExit, onUserInterrupt, onUserInput,
    ...opts,
  });
  return { detector, log, onIdle, onIdleExit, onUserInterrupt, onUserInput };
}

async function flush() {
  await new Promise(r => setTimeout(r, 50));
}

describe('OpenCodeTrueIdleDetector', () => {
  let det;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    det = createDetector();
  });

  afterEach(() => {
    det.detector.dispose();
    vi.useRealTimers();
  });

  describe('basic idle detection', () => {
    it('should detect TRUE_IDLE and call onIdle', async () => {
      det.detector.handleEvent({
        event: { type: 'session.status', properties: { sessionID: 's1', status: { type: 'idle' } } },
      });
      det.detector.handleEvent({
        event: { type: 'session.idle', properties: { sessionID: 's1' } },
      });
      expect(det.log).toHaveBeenCalledWith('CANDIDATE', 'session=s1 idle, scheduling check');

      vi.advanceTimersByTime(200);
      await flush();

      expect(det.log).toHaveBeenCalledWith('TRUE_IDLE', expect.stringContaining('session=s1'));
      expect(det.onIdle).toHaveBeenCalledWith('s1');
    });

    it('should debounce when status changes to busy before timeout', async () => {
      det.detector.handleEvent({
        event: { type: 'session.status', properties: { sessionID: 's1', status: { type: 'idle' } } },
      });
      expect(det.log).toHaveBeenCalledWith('CANDIDATE', 'session=s1 idle, scheduling check');

      det.detector.handleEvent({
        event: { type: 'session.status', properties: { sessionID: 's1', status: { type: 'busy' } } },
      });
      expect(det.log).toHaveBeenCalledWith('DEBOUNCE', 'session=s1 cancelled (new busy)');

      vi.advanceTimersByTime(200);
      await flush();

      expect(det.onIdle).not.toHaveBeenCalled();
    });
  });

  describe('ESC interrupt handling', () => {
    it('BUG REPRODUCTION: handleCancel should set #interrupted and block subsequent idle', async () => {
      det.detector.handleCancel('s1');

      expect(det.log).toHaveBeenCalledWith('INTERRUPT', 'session=s1 session cancelled by user (ESC)');
      expect(det.detector.interrupted).toBe(true);
      expect(det.onUserInterrupt).toHaveBeenCalledWith('s1');

      det.detector.handleEvent({
        event: { type: 'session.status', properties: { sessionID: 's1', status: { type: 'idle' } } },
      });
      expect(det.log).toHaveBeenCalledWith('CANDIDATE', 'session=s1 idle, scheduling check');

      vi.advanceTimersByTime(200);
      await flush();

      expect(det.log).toHaveBeenCalledWith('SKIP', expect.stringContaining('interrupted'));
      expect(det.onIdle).not.toHaveBeenCalled();
    });

    it('BUG REPRODUCTION: session.error with MessageAbortedError should set #interrupted', async () => {
      det.detector.handleEvent({
        event: {
          type: 'session.error',
          properties: {
            sessionID: 's1',
            error: { name: 'MessageAbortedError', data: { message: 'cancelled' } },
          },
        },
      });

      expect(det.log).toHaveBeenCalledWith('INTERRUPT',
        expect.stringContaining('session.error with MessageAbortedError'));
      expect(det.detector.interrupted).toBe(true);
      expect(det.onUserInterrupt).toHaveBeenCalledWith('s1');

      det.detector.handleEvent({
        event: { type: 'session.status', properties: { sessionID: 's1', status: { type: 'idle' } } },
      });
      vi.advanceTimersByTime(200);
      await flush();

      expect(det.onIdle).not.toHaveBeenCalled();
    });

    it('should detect interrupt via handleChatMessage with MessageAbortedError', async () => {
      det.detector.handleChatMessage(
        { sessionID: 's1', messageID: 'm1' },
        {
          message: { role: 'assistant', error: { name: 'MessageAbortedError', data: { message: 'esc' } } },
          parts: [],
        },
      );

      expect(det.log).toHaveBeenCalledWith('INTERRUPT',
        'session=s1 msg=m1 AI response aborted by user');
      expect(det.detector.interrupted).toBe(true);
      expect(det.onUserInterrupt).toHaveBeenCalledWith('s1');
    });
  });

  describe('user input after interrupt', () => {
    it('should resume idle detection after interrupt + user input', async () => {
      det.detector.handleCancel('s1');
      expect(det.detector.interrupted).toBe(true);

      vi.clearAllMocks();

      det.detector.handleChatMessage(
        { sessionID: 's1', messageID: 'm1' },
        {
          message: { role: 'user', content: 'hi' },
          parts: [{ type: 'text', text: 'hi' }],
        },
      );

      expect(det.detector.interrupted).toBe(false);
      expect(det.onUserInput).toHaveBeenCalledWith('s1');

      det.detector.handleEvent({
        event: { type: 'session.status', properties: { sessionID: 's1', status: { type: 'idle' } } },
      });
      vi.advanceTimersByTime(200);
      await flush();

      expect(det.onIdle).toHaveBeenCalledWith('s1');
    });
  });

  describe('skipNextUserMessage', () => {
    it('should skip user message when skipNextUserMessage is set', async () => {
      det.detector.setSkipNextUserMessage();

      det.detector.handleChatMessage(
        { sessionID: 's1', messageID: 'm1' },
        {
          message: { role: 'user', content: 'hello' },
          parts: [{ type: 'text', text: 'hello' }],
        },
      );

      expect(det.onUserInput).not.toHaveBeenCalled();
      expect(det.onIdleExit).not.toHaveBeenCalled();
    });

    it('should NOT skip subsequent user messages after skipNextUserMessage expires', async () => {
      det.detector.setSkipNextUserMessage();

      det.detector.handleChatMessage(
        { sessionID: 's1', messageID: 'm1' },
        {
          message: { role: 'user', content: 'hello' },
          parts: [{ type: 'text', text: 'hello' }],
        },
      );
      expect(det.onUserInput).not.toHaveBeenCalled();

      det.detector.handleChatMessage(
        { sessionID: 's1', messageID: 'm2' },
        {
          message: { role: 'user', content: 'real message' },
          parts: [{ type: 'text', text: 'real message' }],
        },
      );
      expect(det.onUserInput).toHaveBeenCalledWith('s1');
    });
  });

  describe('exponential backoff', () => {
    it('should double delay after each TRUE_IDLE', async () => {
      for (let i = 0; i < 3; i++) {
        det.detector.handleEvent({
          event: { type: 'session.status', properties: { sessionID: 's1', status: { type: 'idle' } } },
        });
        vi.advanceTimersByTime(200 * Math.pow(2, i));
        await flush();
      }

      const trueIdleCalls = det.log.mock.calls.filter(c => c[0] === 'TRUE_IDLE');
      expect(trueIdleCalls.length).toBe(3);
      expect(det.onIdle).toHaveBeenCalledTimes(3);
    });
  });

  describe('onIdleExit', () => {
    it('should fire onIdleExit when idle→busy transition occurs', async () => {
      det.detector.handleEvent({
        event: { type: 'session.status', properties: { sessionID: 's1', status: { type: 'idle' } } },
      });

      det.detector.handleEvent({
        event: { type: 'session.status', properties: { sessionID: 's1', status: { type: 'busy' } } },
      });

      expect(det.onIdleExit).toHaveBeenCalledWith('s1');
    });
  });

  describe('permission and question events', () => {
    it('should delay idle when permission is pending', async () => {
      det.detector.handleEvent({
        event: { type: 'session.status', properties: { sessionID: 's1', status: { type: 'idle' } } },
      });
      det.detector.handleEvent({
        event: { type: 'permission.asked', properties: { sessionID: 's1', action: 'read' } },
      });

      vi.advanceTimersByTime(200);
      await flush();

      expect(det.onIdle).not.toHaveBeenCalled();
      expect(det.log).toHaveBeenCalledWith('SKIP', expect.stringContaining('not true idle'));
    });

    it('should recheck when permission is resolved', async () => {
      det.detector.handleEvent({
        event: { type: 'session.status', properties: { sessionID: 's1', status: { type: 'idle' } } },
      });
      det.detector.handleEvent({
        event: { type: 'permission.asked', properties: { sessionID: 's1', action: 'read' } },
      });
      det.detector.handleEvent({
        event: { type: 'permission.replied', properties: { sessionID: 's1', reply: 'allow' } },
      });

      vi.advanceTimersByTime(200);
      await flush();

      expect(det.onIdle).toHaveBeenCalledWith('s1');
    });
  });
});
