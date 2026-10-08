import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import { freshInteractive, interactiveResume } from '../launch.mjs';
import { nativeSession } from '../native-sandbox.mjs';
import { nativeSubcommand } from '../native-command.mjs';

const fresh = (kind, args) => freshInteractive({ kind, args, cwd: '/not-a-project', env: {}, tty: true });
const resume = (kind, args) => interactiveResume({ kind, args, tty: true });

test('utility words used as option values or prompt text retain fresh session handling', () => {
  for (const kind of ['claude', 'codex']) {
    for (const args of [['--add-dir', 'logs'], ['--model', 'stop'], ['--settings', 'rm'], ['--model=logs'], ['Write', 'stop'], ['--', 'stop']]) {
      assert.equal(fresh(kind, args), true, `${kind} ${args.join(' ')}`);
      assert.equal(nativeSession(kind, args), true, `${kind} ${args.join(' ')}`);
    }
  }
});

test('utility words used as resume IDs, option values and later prompts retain resume handling', () => {
  for (const args of [['--resume', 'rm'], ['-r', 'stop'], ['--resume=logs'], ['--resume', '--model', 'logs'], ['--continue', '--model', 'stop'], ['--continue', 'Write', 'logs']]) {
    assert.equal(resume('claude', args), true, args.join(' '));
    assert.equal(nativeSession('claude', args), true, args.join(' '));
    assert.equal(fresh('claude', args), false, args.join(' '));
  }
  for (const args of [['resume', 'help'], ['--model', 'login', 'resume', 'debug']]) {
    assert.equal(resume('codex', args), true, args.join(' '));
    assert.equal(nativeSession('codex', args), true, args.join(' '));
    assert.equal(fresh('codex', args), false, args.join(' '));
  }
  assert.equal(resume('codex', ['--model', 'resume']), false);
  assert.equal(resume('codex', ['exec', 'resume']), false);
});

test('only utility subcommands suppress native session handling', () => {
  for (const [kind, args] of [
    ['claude', ['logs']], ['claude', ['stop']], ['claude', ['mcp', 'list']],
    ['claude', ['--model', 'literal', 'logs']], ['claude', ['--resume', 'rm', 'logs']],
    ['claude', ['--continue', 'logs']], ['claude', ['-c', 'logs']],
    ['codex', ['login']], ['codex', ['--model', 'literal', 'login']],
    ['codex', ['-c', 'model="literal"', 'login']], ['codex', ['-p', 'literal', 'login']],
  ]) {
    assert.equal(fresh(kind, args), false, `${kind} ${args.join(' ')}`);
    assert.equal(resume(kind, args), false, `${kind} ${args.join(' ')}`);
    assert.equal(nativeSession(kind, args), false, `${kind} ${args.join(' ')}`);
  }
});

test('shared command scan skips value options and handles inline values and prompt terminators', () => {
  for (const kind of ['claude', 'codex']) {
    for (const option of ['--config', '-m', '--model', '--profile', '-C', '--cd', '--add-dir', '--effort', '--settings', '--permission-mode', '--setting-sources']) {
      assert.equal(nativeSubcommand(kind, [option, 'stop', 'mcp', 'list']), 'mcp', `${kind} ${option}`);
    }
    assert.equal(nativeSubcommand(kind, ['--model=stop', 'mcp', 'list']), 'mcp');
    assert.equal(nativeSubcommand(kind, ['--', 'stop']), undefined);
  }
});

test('help, version, headless, resume and worktree option checks remain intact', () => {
  for (const kind of ['claude', 'codex']) {
    for (const flag of ['--help', '-h', '--version', '-V']) {
      const args = kind === 'claude' ? ['--resume', 'rm', flag] : ['resume', 'help', flag];
      assert.equal(fresh(kind, args), false);
      assert.equal(resume(kind, args), false);
      assert.equal(nativeSession(kind, args), false);
    }
    for (const flag of ['--resume', '--continue', '--fork-session', '--worktree', '-w', '-C', '--cd']) assert.equal(fresh(kind, [flag]), false);
  }
  for (const flag of ['--print', '-p']) {
    assert.equal(fresh('claude', [flag, 'stop']), false);
    assert.equal(resume('claude', ['--resume', 'rm', flag, 'stop']), false);
    assert.equal(nativeSession('claude', [flag, 'stop']), true);
  }
  for (const subcommand of ['exec', 'x', 'review', 'resume', 'fork']) assert.equal(fresh('codex', [subcommand, 'task']), false);
  assert.equal(interactiveResume({ kind: 'claude', args: ['--resume', 'rm'], tty: false }), false);
  assert.equal(freshInteractive({ kind: 'claude', args: ['--model', 'logs'], tty: false }), false);
});
