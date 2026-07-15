export const claudeTranscriptFixture = (sessionId: string, cwd = '/repo') => [
  JSON.stringify({ type: 'summary', summary: 'A session', leafUuid: 'x' }),
  JSON.stringify({ type: 'user', sessionId, cwd, timestamp: '2026-07-01T10:00:00.000Z', message: { role: 'user', content: 'hi' } }),
  JSON.stringify({ type: 'assistant', sessionId, cwd, timestamp: '2026-07-01T10:00:05.000Z', requestId: 'req_1', message: { model: 'claude-opus-4-8', content: [{ type: 'text', text: 'Hello!' }], usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 200, cache_creation_input_tokens: 50 } } }),
  JSON.stringify({ type: 'assistant', sessionId, cwd, timestamp: '2026-07-01T10:00:06.000Z', requestId: 'req_1', message: { model: 'claude-opus-4-8', content: [{ type: 'text', text: 'More.' }], usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 200, cache_creation_input_tokens: 50 } } }),
  'not json',
  JSON.stringify({ type: 'assistant', sessionId, cwd, isSidechain: true, timestamp: '2026-07-01T10:01:00.000Z', requestId: 'req_2', message: { model: 'claude-haiku-4-5', content: [{ type: 'tool_use', name: 'Bash' }], usage: { input_tokens: 5, output_tokens: 7, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }),
].join('\n') + '\n';

export const claudeNoiseFixture = () =>
  JSON.stringify({ type: 'summary', summary: 'title only', leafUuid: 'y' }) + '\n';

export const CLAUDE_RAW_BODY = JSON.stringify({
  model: 'claude-opus-4-8', messages: [],
  metadata: { user_id: 'user_abc_account_def_session_11111111-1111-1111-1111-111111111111' },
});

export const CLAUDE_RAW_BODY_JSON_UID = JSON.stringify({
  model: 'claude-opus-4-8', messages: [],
  metadata: { user_id: JSON.stringify({ device_id: 'd1', account_uuid: 'a1', session_id: '33333333-3333-3333-3333-333333333333' }) },
});
