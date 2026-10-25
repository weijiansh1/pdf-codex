import { expect, it } from 'vitest';
import { terminalProxyEnvironment } from '../../plugins/latex-report-workbench/src/server/terminal-network.js';

it('uses the already enabled Windows HTTPS proxy and keeps local daemon traffic local', () => {
  const env = terminalProxyEnvironment({ PATH: 'fixture', NO_PROXY: 'example.test' }, { enabled: true, server: 'http=127.0.0.1:7887;https=127.0.0.1:7888' });
  expect(env.HTTPS_PROXY).toBe('http://127.0.0.1:7888');
  expect(env.HTTP_PROXY).toBe('http://127.0.0.1:7887');
  expect(env.NO_PROXY).toContain('127.0.0.1');
  expect(env.NO_PROXY).toContain('example.test');
});

it('respects explicit environment proxies and does not enable a disabled system proxy', () => {
  expect(terminalProxyEnvironment({ HTTPS_PROXY: 'http://explicit.test:80' }, { enabled: true, server: '127.0.0.1:7888' }).HTTPS_PROXY).toBe('http://explicit.test:80');
  expect(terminalProxyEnvironment({}, { enabled: false, server: '127.0.0.1:7888' }).HTTPS_PROXY).toBeUndefined();
  expect(terminalProxyEnvironment({}, { enabled: true, server: 'invalid proxy data' }).HTTPS_PROXY).toBeUndefined();
});

it('separates the CLI from its parent desktop task while retaining user configuration and auth', () => {
  const env = terminalProxyEnvironment({ CODEX_HOME: 'fixture-home', OPENAI_API_KEY: 'fixture-key', CODEX_THREAD_ID: 'parent', CODEX_SESSION_ID: 'parent-session', CODEX_APP_TOOLS_PIPE_PATH: 'parent-pipe', CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'desktop', CODEX_CI: '1' }, { enabled: false, server: '' });
  expect(env.CODEX_THREAD_ID).toBeUndefined(); expect(env.CODEX_SESSION_ID).toBeUndefined(); expect(env.CODEX_APP_TOOLS_PIPE_PATH).toBeUndefined(); expect(env.CODEX_CI).toBeUndefined();
  expect(env.CODEX_HOME).toBe('fixture-home'); expect(env.OPENAI_API_KEY).toBe('fixture-key');
});
