export const rolloutFixture = (cwd: string) => [
  JSON.stringify({ timestamp: '2026-07-14T18:07:23.308Z', type: 'session_meta', payload: { id: '019f-test', timestamp: '2026-07-14T18:07:23.308Z', cwd, originator: 'codex_exec', cli_version: '0.141.0' } }),
  JSON.stringify({ timestamp: '2026-07-14T18:07:25.000Z', type: 'turn_context', payload: { turn_id: 't1', cwd, model: 'gpt-5.3-codex' } }),
  JSON.stringify({ timestamp: '2026-07-14T18:07:26.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Reply with exactly: PROXY-OK' }] } }),
  JSON.stringify({ timestamp: '2026-07-14T18:07:30.000Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 21964, cached_input_tokens: 17152, output_tokens: 256, reasoning_output_tokens: 85, total_tokens: 22220 }, last_token_usage: { input_tokens: 21964, cached_input_tokens: 17152, output_tokens: 256, reasoning_output_tokens: 85, total_tokens: 22220 } } } }),
  JSON.stringify({ timestamp: '2026-07-14T18:07:31.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'PROXY-OK' }] } }),
  JSON.stringify({ timestamp: '2026-07-14T18:07:32.000Z', type: 'event_msg', payload: { type: 'token_count', info: null } }),
].join('\n') + '\n';
