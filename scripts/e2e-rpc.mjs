import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';

export function startPi({ agentDir, sessionDir, extension = true, env = {}, live = false }) {
  const bin = process.env.PI_EVERGREEN_PI_BIN;
  assert.ok(bin, 'PI_EVERGREEN_PI_BIN must name the installed global Pi CLI');
  const args = ['--offline', '--mode', 'rpc', '--no-extensions', '--no-skills',
    '--no-prompt-templates', '--no-themes', '--no-context-files', '--no-mcp',
    '--session-dir', sessionDir, '--tools', live ? '' : 'read',
    '--provider', live ? (process.env.PI_EVERGREEN_E2E_PROVIDER ?? 'openai') : 'limits-wait-fixture',
    '--model', live ? (process.env.PI_EVERGREEN_E2E_MODEL ?? 'gpt-6-luna') : 'sentinel',
    '--thinking', live ? (process.env.PI_EVERGREEN_E2E_REASONING ?? 'medium') : 'off',
    '-e', resolve('scripts/e2e-fixture.ts')];
  if (extension) args.push('-e', resolve('src/index.ts'));
  const child = spawn(bin, args, {
    cwd: process.cwd(), env: { ...process.env,
      ...(agentDir ? { PI_CODING_AGENT_DIR: agentDir } : {}),
      PI_LIMITS_WAIT_DISABLE_ALL_WAITING: 'false', PI_LIMITS_WAIT_MAX_RETRY: '1',
      PI_LIMITS_WAIT_RETRY_INTERVAL: '0', ...env }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  const events = [];
  createInterface({ input: child.stdout }).on('line', line => {
    try { events.push(JSON.parse(line)); } catch { /* non-protocol startup diagnostic */ }
  });
  const wait = async predicate => {
    const deadline = Date.now() + (live ? 180000 : 45000);
    for (;;) {
      const found = events.find(predicate);
      if (found) return found;
      assert.equal(child.exitCode, null, `Pi exited: ${stderr}`);
      assert.ok(Date.now() < deadline, `Timed out waiting for RPC event: ${stderr}\n${JSON.stringify(events).slice(-3000)}`);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  let id = 0;
  const command = async (type, fields = {}) => {
    const requestId = String(++id);
    child.stdin.write(JSON.stringify({ id: requestId, type, ...fields }) + '\n');
    const reply = await wait(e => e.type === 'response' && e.id === requestId);
    assert.equal(reply.success, true, JSON.stringify(reply));
    return reply.data;
  };
  return {
    events, command, wait,
    async prompt(message) {
      const start = events.length;
      await command('prompt', { message });
      await wait(e => events.indexOf(e) >= start && e.type === 'agent_settled');
      const state = await command('get_state');
      assert.equal(state.isStreaming, false);
    },
    async close() {
      child.kill('SIGTERM');
      await new Promise(resolve => child.once('close', resolve));
    },
  };
}
