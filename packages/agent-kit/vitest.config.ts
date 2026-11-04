import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// 测试用引擎的源码（不需要先构建 packages/engine）
export default defineConfig({
  resolve: {
    alias: { 'bot-game-mcp': fileURLToPath(new URL('../engine/src/index.ts', import.meta.url)) },
  },
  test: {
    name: 'agent-kit',
    include: ['test/**/*.test.ts'],
    testTimeout: 30000,
  },
});
