import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { startPi } from './e2e-rpc.mjs';

// All artifacts remain inside this repository; no real credentials are read.
await mkdir('tmp', { recursive: true });
const root = await mkdtemp(resolve('tmp/evergreen-'));
const requests = [];
const transports = [];
let plan = [];
const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  requests.push(JSON.parse(Buffer.concat(chunks).toString()));
  transports.push({ path: req.url, headers: req.headers });
  const action = plan.shift() ?? 'text';
  if (action === 'workspace') {
    res.writeHead(429, { 'content-type': 'application/json', 'retry-after-ms': '60000' });
    res.end(JSON.stringify({ error: { type: 'subscription_sharing_workplace_individual_usage_limit_exceeded',
      code: 'subscription_sharing_workplace_individual_usage_limit_exceeded', message: 'workspace limit' } }));
    return;
  }
  if (req.url.startsWith('/target')) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const chunk of [
      { choices: [{ index: 0, delta: { role: 'assistant', content: 'OK target.' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } },
    ]) res.write(`data: ${JSON.stringify({ id: 'target-sentinel', object: 'chat.completion.chunk', created: 1, model: 'target', ...chunk })}\n\n`);
    res.end('data: [DONE]\n\n');
    return;
  }
  if (action === 'overflow') {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too long: 200001 tokens > 200000 maximum' } }));
    return;
  }
  if (action === '429' || action === 'long429') {
    res.writeHead(429, { 'content-type': 'application/json', 'retry-after-ms': action === 'long429' ? '60000' : '10' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'fixture rate limit' } }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const emit = (type, fields = {}) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
  emit('message_start', { message: { id: 'msg_sentinel', type: 'message', role: 'assistant', model: 'sentinel',
    content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
  const tool = action === 'tool';
  emit('content_block_start', { index: 0, content_block: tool
    ? { type: 'tool_use', id: 'call_sentinel', name: 'Read', input: {} }
    : { type: 'text', text: '' } });
  emit('content_block_delta', { index: 0, delta: tool
    ? { type: 'input_json_delta', partial_json: JSON.stringify({ path: join(root, 'tool.txt') }) }
    : { type: 'text_delta', text: 'OK sentinel summary.' } });
  emit('content_block_stop', { index: 0 });
  emit('message_delta', { delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } });
  emit('message_stop');
  res.end();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const endpoint = `http://127.0.0.1:${server.address().port}`;
const identity = "You are Claude Code, Anthropic's official CLI for Claude.";
function assertClean(batch) {
  assert.ok(batch.length > 0, 'must observe real HTTP requests');
  for (const payload of batch) {
    assert.equal(payload.system[0].text, identity);
    assert.doesNotMatch(JSON.stringify(payload), /FORBIDDEN_HOST_SENTINEL|pi-coding-agent|operating inside pi/);
  }
}
async function local(name, options, run) {
  const dir = join(root, name);
  await mkdir(dir);
  await writeFile(join(dir, 'settings.json'), JSON.stringify({
    compaction: { keepRecentTokens: 1, reserveTokens: 256 }, retry: { provider: { maxRetries: 0 } },
  }));
  if (options.env?.LIMITS_WAIT_E2E_FALLBACK) {
    await writeFile(join(dir, 'limits-wait.json'), JSON.stringify({
      'fallback-models': [{ provider: 'openrouter', modelname: 'target' }],
    }));
  }
  const pi = startPi({ agentDir: dir, sessionDir: dir, ...options,
    env: { LIMITS_WAIT_E2E_ENDPOINT: endpoint, ...options.env } });
  try { await run(pi, dir); } finally { await pi.close(); }
}
try {
  await writeFile(join(root, 'tool.txt'), 'TOOL_RESULT_SENTINEL');
  await local('negative-control', { extension: false }, async pi => {
    const start = requests.length;
    await pi.prompt('Reply OK.');
    assert.throws(() => assertClean(requests.slice(start)), /FORBIDDEN|match/);
    assert.match(JSON.stringify(requests.slice(start)), /FORBIDDEN_HOST_SENTINEL_1/);
  });
  console.log('PASS CLI transport negative control detects unsanitised host prompt');
  await local('enabled', {}, async (pi, dir) => {
    await pi.command('set_auto_retry', { enabled: false });
    const start = requests.length;
    plan = ['429', 'tool', 'text'];
    await pi.prompt('Read the sentinel file, then reply OK.');
    assert.equal(requests.length - start, 3, 'extension retry and tool follow-up must both reach transport');
    assert.match(JSON.stringify(requests.at(-1)), /TOOL_RESULT_SENTINEL/);
    await pi.prompt('Reply OK again.');
    assert.match(JSON.stringify(requests.at(-1)), /KEEP_SENTINEL_2/);
    // Real summary request, not an injected compaction result.
    const compact = await pi.command('compact', { customInstructions: 'Keep only sentinel facts.' });
    assert.ok(compact.summary);
    await pi.prompt('Reply OK after compaction.');
    plan = ['overflow', 'text', 'text'];
    await pi.prompt('Reply OK after automatic overflow recovery.');
    assert.equal(plan.length, 0, 'overflow must reach Pi compaction and then retry, not extension retry');
    assertClean(requests.slice(start));
    const entries = (await pi.command('get_entries')).entries;
    assert.equal(entries.filter(e => e.type === 'custom' && e.customType === 'limits-wait').length, 1);
    assert.equal(entries.filter(e => e.type === 'compaction').length, 2, 'manual and Pi-owned overflow compactions');
    assert.doesNotMatch(JSON.stringify(requests.slice(start)), /retries_total|totalWaitingTime/, 'retry metadata must never enter provider context');
    const session = (await pi.command('get_state')).sessionFile;
    const disk = await readFile(session, 'utf8');
    assert.match(disk, /limits-wait/);
    assert.equal((disk.match(/"customType":"limits-wait"/g) ?? []).length, 1);
    await pi.command('new_session');
    const next = requests.length;
    await pi.prompt('Reply OK in the new session.');
    assertClean(requests.slice(next));
    assert.equal((await pi.command('get_entries')).entries.filter(e => e.customType === 'limits-wait').length, 0);
    plan = ['429', 'text'];
    await pi.prompt('Reply OK after replacement retry.');
    assert.equal(plan.length, 0, 'session replacement must reinstall retry interception');
    await pi.command('prompt', { message: '/e2e-reload' });
    plan = ['429', 'text'];
    await pi.prompt('Reply OK after reload retry.');
    assert.equal(plan.length, 0, 'reload must retain exactly one functioning interception owner');
    const replacedEntries = (await pi.command('get_entries')).entries;
    assert.equal(replacedEntries.filter(e => e.customType === 'limits-wait').length, 2);
    assertClean(requests.slice(next));
    assert.ok((await readdir(dir)).some(name => name.endsWith('.jsonl')));
  });
  console.log('PASS CLI OAuth cleaning across retries, tools, prompt deltas, compaction, session replacement; durable summary');
  await local('disabled', { env: { PI_LIMITS_WAIT_DISABLE_ALL_WAITING: 'true' } }, async pi => {
    await pi.command('set_auto_retry', { enabled: false });
    const start = requests.length;
    plan = ['429'];
    await pi.prompt('Reply OK.');
    assert.equal(requests.length - start, 1);
    assertClean(requests.slice(start));
    assert.equal((await pi.command('get_entries')).entries.filter(e => e.customType === 'limits-wait').length, 0);
  });
  console.log('PASS CLI kill switch surfaces first failure but still cleans prompts');
  await local('abort', {}, async pi => {
    await pi.command('set_auto_retry', { enabled: false });
    const start = requests.length;
    plan = ['long429'];
    await pi.command('prompt', { message: 'Reply OK.' });
    await pi.wait(e => e.type === 'extension_ui_request' && e.method === 'setStatus' &&
      typeof e.statusText === 'string' && e.statusText.includes('"event":"wait"'));
    await pi.command('abort');
    assert.equal(requests.length - start, 1, 'abort must not retry during wait');
    const entries = (await pi.command('get_entries')).entries;
    assert.ok(entries.some(e => e.message?.stopReason === 'aborted'));
    assert.equal(entries.find(e => e.customType === 'limits-wait').data.retries_total, 0);
    await pi.prompt('Reply OK after abort.');
    assert.equal(requests.length - start, 2, 'next request is not stranded by aborted wait');
    assertClean(requests.slice(start));
  });
  console.log('PASS CLI abort interrupts real retry wait, persists no completed retry, and allows the next turn');
  await local('cross-provider', { env: { LIMITS_WAIT_E2E_FALLBACK: '1' } }, async pi => {
    await pi.command('set_auto_retry', { enabled: false });
    for (const transition of ['initial', 'reload', 'new-session']) {
      if (transition === 'reload') await pi.command('prompt', { message: '/e2e-reload' });
      if (transition === 'new-session') await pi.command('new_session');
      // Force a genuine manual-selection event even when /new restores source.
      await pi.command('set_model', { provider: 'openrouter', modelId: 'target' });
      await pi.command('set_model', { provider: 'limits-wait-fixture', modelId: 'sentinel' });
      const start = requests.length;
      const eventStart = pi.events.length;
      plan = ['long429', 'text', 'text'];
      await pi.prompt('Reply OK via fallback.');
      assert.ok(pi.events.slice(eventStart).some(e => e.type === 'extension_ui_request' && e.statusKey === 'e2e-provider-stream'),
        'fallback provider stream instrumentation must reach extensions before the next turn');
      await pi.prompt('Reply OK for the next turn.');
      const batch = transports.slice(start);
      assert.equal(batch.length, 3, transition);
      assert.equal(batch[0].headers['x-source-secret'], 'SOURCE_SECRET_SENTINEL');
      assert.equal(batch[0].headers['x-source-hook-secret'], 'SOURCE_HOOK_SECRET_SENTINEL');
      for (const frame of batch.slice(1)) {
        assert.equal(frame.path, '/target/chat/completions');
        assert.equal(frame.headers.authorization, 'Bearer TARGET_KEY_SENTINEL');
        assert.equal(frame.headers['x-target-config'], 'TARGET_CONFIG_SENTINEL');
        assert.equal(frame.headers['x-target-hook'], 'TARGET_HOOK_SENTINEL', 'target hook must run on fallback AND next turn');
        assert.equal(frame.headers['x-delete-me'], undefined);
        assert.equal(frame.headers['x-openrouter-title'], undefined, 'null must suppress 1.4 attribution');
        assert.equal(frame.headers['http-referer'], 'https://pi.dev', 'native target attribution must survive');
        assert.doesNotMatch(JSON.stringify(frame), /SOURCE_.*SECRET_SENTINEL|sk-ant-oat01/);
      }
      const entries = (await pi.command('get_entries')).entries;
      assert.ok(entries.some(e => e.message?.provider === 'openrouter' && e.message.stopReason === 'stop'));
    }
  });
  console.log('PASS CLI cross-provider target header insertion/deletion, native attribution, source-secret isolation, stream events across turns/reload/replacement');
  for (const waiting of [false, true]) {
    await local(`workspace-${waiting}`, { env: {
      LIMITS_WAIT_E2E_WORKSPACE: '1', PI_LIMITS_WAIT_DEFAULT_WAITING: String(waiting),
      PI_LIMITS_WAIT_MAX_RETRY: '1',
    } }, async pi => {
      await pi.command('set_auto_retry', { enabled: true });
      await pi.command('set_model', { provider: 'openai', modelId: 'workspace' });
      const start = requests.length;
      plan = ['workspace', 'workspace'];
      await pi.prompt('Reply OK.');
      assert.equal(requests.length - start, waiting ? 2 : 1, 'workspace limits use bounded unknown retry setting, not timed rate-limit waits or Pi auto-retry');
      const messages = (await pi.command('get_messages')).messages;
      const error = messages.at(-1);
      assert.equal(error.stopReason, 'error');
      assert.match(error.errorMessage, /subscription_sharing_workplace_individual_usage_limit_exceeded/);
      assert.match(error.errorMessage, /workspace admin/);
      const entries = (await pi.command('get_entries')).entries;
      const summaries = entries.filter(e => e.customType === 'limits-wait');
      assert.equal(summaries.length, waiting ? 1 : 0);
      if (waiting) assert.equal(summaries[0].data.retries_total, 1);
      plan = [];
    });
  }
  console.log('PASS CLI real OpenAI Responses workspace error retains admin hint and bounded configurable retries with Pi auto-retry enabled');
  // Required live smoke: owner-selected model, no fallback to a maintenance model.
  const capture = join(root, 'live-transport.jsonl');
  const pi = startPi({ sessionDir: join(root, 'live'), live: true,
    env: { LIMITS_WAIT_E2E_CAPTURE: capture } });
  try {
    await pi.command('set_auto_retry', { enabled: false });
    await pi.prompt('Reply with only OK.');
    await pi.prompt('Reply with only OK again.');
    const bodies = (await readFile(capture, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(bodies.length, 2, 'capture must see exactly two actual provider HTTP responses');
    assert.ok(bodies.every(frame => frame.status === 200));
    assert.match(JSON.stringify(bodies[0].body), /KEEP_SENTINEL_1/);
    assert.match(JSON.stringify(bodies[1].body), /KEEP_SENTINEL_2/);
    // Non-Anthropic requests are intentionally unchanged, not globally redacted.
    if ((process.env.PI_EVERGREEN_E2E_PROVIDER ?? 'openai') === 'openai') {
      assert.match(JSON.stringify(bodies[1].body), /FORBIDDEN_HOST_SENTINEL_2/);
    }
    const messages = (await pi.command('get_messages')).messages;
    assert.equal(messages.filter(m => m.role === 'assistant' && m.stopReason !== 'error').length, 2);
    assert.ok(!messages.some(m => m.stopReason === 'error' || m.stopReason === 'aborted'));
  } finally { await pi.close(); }
  console.log('PASS live global CLI configured-model multi-turn transport smoke');
} finally {
  await new Promise(resolve => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
