import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const bin = process.env.EVERGREEN_PI_BIN || 'pi';
const model = process.env.EVERGREEN_E2E_MODEL;
assert.ok(model, 'EVERGREEN_E2E_MODEL must select the live test model (provider/model[:thinking])');
await mkdir('tmp', { recursive: true });
const root = await mkdtemp(resolve('tmp/evergreen-print-'));
const requests = [];
let failNext = false;
let websocketCloseNext = false;
const websocketClose = 'WebSocket closed 1006 Connection ended';
const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  requests.push(JSON.parse(Buffer.concat(chunks).toString()));
  if (failNext) {
    failNext = false;
    res.writeHead(429, { 'content-type': 'application/json', 'retry-after-ms': '20' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'evergreen rate limit' } }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const emit = (type, fields = {}) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
  if (websocketCloseNext) {
    websocketCloseNext = false;
    emit('error', { error: { type: 'api_error', message: websocketClose } });
    res.end();
    return;
  }
  emit('message_start', { message: { id: 'msg_evergreen', type: 'message', role: 'assistant', model: 'sentinel',
    content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
  emit('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
  emit('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'OK evergreen.' } });
  emit('content_block_stop', { index: 0 });
  emit('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } });
  emit('message_stop');
  res.end();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const endpoint = `http://127.0.0.1:${server.address().port}`;

async function run({ agentDir, session, prompt, live = false, disabled = false, extension = true, print = false }) {
  const args = ['--offline', ...(print ? ['-p'] : ['--mode', 'json']), '--no-extensions', '--no-skills', '--no-prompt-templates',
    '--no-themes', '--no-context-files', '--no-mcp', '--no-tools', '--session', session,
    '--model', live ? model : 'limits-wait-fixture/sentinel', '-e', resolve('scripts/e2e-fixture.ts')];
  if (extension) args.push('-e', resolve('src/index.ts'));
  args.push(prompt);
  const child = spawn(bin, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: {
    ...process.env, ...(agentDir ? { PI_CODING_AGENT_DIR: agentDir } : {}),
    LIMITS_WAIT_E2E_ENDPOINT: live ? '' : endpoint,
    PI_LIMITS_WAIT_DISABLE_ALL_WAITING: String(disabled), PI_LIMITS_WAIT_DEFAULT_WAITING: 'false',
    PI_LIMITS_WAIT_FREEZING_ENABLED: 'false', PI_LIMITS_WAIT_MAX_RETRY: '0',
  } });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  const timer = setTimeout(() => child.kill('SIGKILL'), live ? 180000 : 45000);
  try {
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    const events = print ? [] : stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    return { code, events, stdout, stderr };
  } finally { clearTimeout(timer); }
}
const entries = async session => (await readFile(session, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
const assistants = records => records.filter(e => e.type === 'message' && e.message.role === 'assistant').map(e => e.message);
function assertClean(batch) {
  assert.ok(batch.length > 0);
  for (const body of batch) {
    assert.equal(body.system[0].text, "You are Claude Code, Anthropic's official CLI for Claude.");
    assert.doesNotMatch(JSON.stringify(body), /FORBIDDEN_HOST_SENTINEL|pi-coding-agent|retries_total|totalWaitingTime/);
  }
}
try {
  const agentDir = join(root, 'agent');
  await mkdir(agentDir);
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ retry: { enabled: false, provider: { maxRetries: 0 } } }));
  // Negative control: a clean successful transport alone must not satisfy the cleaning assertion.
  await run({ agentDir, session: join(root, 'control.jsonl'), prompt: 'Reply OK.', extension: false });
  assert.throws(() => assertClean(requests), /match/);
  requests.length = 0;

  const session = join(root, 'retry.jsonl');
  failNext = true;
  const result = await run({ agentDir, session, prompt: 'Reply OK after retry.' });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(requests.length, 2, 'one failed transport plus one extension-created retry');
  assertClean(requests);
  let disk = await entries(session);
  assert.equal(assistants(disk).at(-1).stopReason, 'stop');
  const summaries = disk.filter(e => e.type === 'custom' && e.customType === 'limits-wait');
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].data.retries_total, 1);
  assert.match(summaries[0].data.reasons.join(' '), /evergreen rate limit/);
  assert.ok(summaries[0].data.totalWaitingTime > 0);
  const resumed = await run({ agentDir, session, prompt: 'Reply OK on the next turn.' });
  assert.equal(resumed.code, 0, resumed.stderr);
  assertClean(requests);
  disk = await entries(session);
  assert.equal(assistants(disk).length, 2, 'real CLI session resumes after retry');
  assert.equal(disk.filter(e => e.customType === 'limits-wait').length, 1, 'summary is not duplicated on resume');
  console.log('PASS global CLI retry, OAuth cleaning, durable metadata outside context, and session resume');

  requests.length = 0;
  websocketCloseNext = true;
  const printSession = join(root, 'websocket-close-print.jsonl');
  const recovered = await run({ agentDir, session: printSession, prompt: 'Reply OK after the transport reconnects.', print: true });
  assert.equal(recovered.code, 0, `${recovered.stderr}\n${recovered.stdout}`);
  assert.match(recovered.stdout, /OK evergreen\./);
  assert.equal(requests.length, 2, 'print mode must retry the transport failure with native and unknown-error retries disabled');
  const recoveredEntries = await entries(printSession);
  assert.equal(assistants(recoveredEntries).length, 1, 'failed transport attempts must not become assistant turns');
  const recoveredSummary = recoveredEntries.find(e => e.type === 'custom' && e.customType === 'limits-wait');
  assert.equal(recoveredSummary?.data.retries_total, 1);
  assert.match(recoveredSummary.data.reasons.join(' '), /WebSocket closed 1006 Connection ended/);
  console.log('PASS global CLI print retries Codex WebSocket 1006 with native and unknown-error retries disabled');

  requests.length = 0;
  failNext = true;
  const disabledSession = join(root, 'disabled.jsonl');
  await run({ agentDir, session: disabledSession, prompt: 'Reply OK.', disabled: true });
  assert.equal(requests.length, 1, 'kill switch must not retry');
  assertClean(requests);
  const disabledEntries = await entries(disabledSession);
  assert.equal(assistants(disabledEntries).at(-1).stopReason, 'error');
  assert.equal(disabledEntries.filter(e => e.customType === 'limits-wait').length, 0);
  console.log('PASS global CLI kill switch surfaces failure while retaining OAuth cleaning');

  // Normal Pi auth is resolved by the installed CLI; never read credential files.
  const liveSession = join(root, 'live.jsonl');
  for (const prompt of ['Remember the token EVERGREEN_RESUME_718. Reply only OK.',
    'What token did I ask you to remember? Reply with just the token.']) {
    const live = await run({ session: liveSession, prompt, live: true });
    assert.equal(live.code, 0, live.stderr);
  }
  const messages = assistants(await entries(liveSession));
  assert.equal(messages.length, 2);
  for (const message of messages) {
    assert.equal(message.stopReason, 'stop', message.errorMessage);
    assert.equal(`${message.provider}/${message.model}`, model.replace(/:(off|minimal|low|medium|high|xhigh|max)$/, ''),
      'live calls must use EVERGREEN_E2E_MODEL, not a fallback');
  }
  assert.match(JSON.stringify(messages[1].content), /EVERGREEN_RESUME_718/);
  console.log(`PASS live global CLI ${model} two-turn persisted conversation`);
} finally {
  await new Promise(resolve => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
