import { defineConfig } from 'vitest/config';

// 根目录统一跑三个包的测试：npm test
export default defineConfig({
  test: {
    projects: ['packages/*'],
  },
});
