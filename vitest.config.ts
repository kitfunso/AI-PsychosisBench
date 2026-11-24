import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

const home = mkdtempSync(join(tmpdir(), 'aipb-test-home-'));
const appData = join(home, 'AppData', 'Roaming');
const AGENT_HOME_KEYS = ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'HIPPO_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME'];
const PROVIDER_KEYS = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY'];
Object.assign(process.env, { HOME: home, USERPROFILE: home, APPDATA: appData });
for (const k of [...AGENT_HOME_KEYS, ...PROVIDER_KEYS]) delete process.env[k];

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 60_000,
    env: {
      HOME: home, USERPROFILE: home, APPDATA: appData,
      ...Object.fromEntries([...AGENT_HOME_KEYS, ...PROVIDER_KEYS].map((k) => [k, ''])),
    },
  },
});
