import assert from 'node:assert/strict';
import test from 'node:test';

import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';

const SESSION_ID = 'session-1';

const SKILL_BODY = [
  'Base directory for this skill: /tmp/claude/bundled-skills/2.1.220/abc123/claude-api',
  '',
  '# Building LLM-Powered Applications with Claude',
  '',
  'This skill helps you build LLM-powered applications with Claude.',
].join('\n');

test('claude: injected skill bodies are hidden even without the isMeta flag', () => {
  const provider = new ClaudeSessionsProvider();

  // The live SDK stream omits `isMeta`, so the payload has to be recognised by
  // its content or it renders as a giant user bubble mid-run.
  const live = provider.normalizeMessage(
    {
      uuid: 'u1',
      timestamp: '2026-07-28T10:00:00.000Z',
      message: { role: 'user', content: [{ type: 'text', text: SKILL_BODY }] },
    },
    SESSION_ID,
  );
  assert.deepEqual(live, []);

  const persisted = provider.normalizeMessage(
    {
      uuid: 'u2',
      timestamp: '2026-07-28T10:00:00.000Z',
      isMeta: true,
      message: { role: 'user', content: [{ type: 'text', text: SKILL_BODY }] },
    },
    SESSION_ID,
  );
  assert.deepEqual(persisted, []);
});

const IMAGE_DIMS_MARKER = '[Image: original 1206x2622, displayed at 920x2000. '
  + 'Multiply coordinates by 1.31 to map to original image.]';

test('claude: image attachment markers are hidden even without the isMeta flag', () => {
  const provider = new ClaudeSessionsProvider();

  // Same split-brain as the skill bodies above: persisted rows carry
  // `isMeta`, the live stream does not, so a marker-only turn shows up as a
  // user bubble during the run and disappears on reload.
  const live = provider.normalizeMessage(
    {
      uuid: 'i1',
      timestamp: '2026-09-15T10:56:01.000Z',
      message: { role: 'user', content: IMAGE_DIMS_MARKER },
    },
    SESSION_ID,
  );
  assert.deepEqual(live, []);

  // Several images in one turn concatenate their markers, so a prefix test
  // would only catch the first.
  const multiple = provider.normalizeMessage(
    {
      uuid: 'i2',
      timestamp: '2026-09-15T10:56:01.000Z',
      message: {
        role: 'user',
        content: [{
          type: 'text',
          text: '[Image: source: /tmp/a.png][Image: source: /tmp/b.png]',
        }],
      },
    },
    SESSION_ID,
  );
  assert.deepEqual(multiple, []);
});

test('claude: a real prompt carrying an image marker is still shown', () => {
  const provider = new ClaudeSessionsProvider();

  const messages = provider.normalizeMessage(
    {
      uuid: 'i3',
      timestamp: '2026-09-15T10:56:01.000Z',
      message: { role: 'user', content: `看这张图 ${IMAGE_DIMS_MARKER}` },
    },
    SESSION_ID,
  );

  // Only marker-*only* content is bookkeeping; the user's words must survive.
  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, 'user');
  assert.match(String(messages[0].content), /看这张图/);
});

test('claude: the Skill tool result itself still reaches the UI', () => {
  const provider = new ClaudeSessionsProvider();

  const messages = provider.normalizeMessage(
    {
      uuid: 'u3',
      timestamp: '2026-07-28T10:00:00.000Z',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Launching skill: claude-api' }],
      },
    },
    SESSION_ID,
  );

  assert.equal(messages.length, 1);
  assert.equal(messages[0].kind, 'tool_result');
  assert.equal(messages[0].toolId, 'toolu_1');
});
