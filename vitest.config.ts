import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { environment: 'node', include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts', 'tests/tex/**/*.test.ts', 'tests/e2e/**/*.test.ts'], testTimeout: 15000 } });
