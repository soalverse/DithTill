import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node', // parity test decodes tests/fixtures/Final.png via sharp (node-only)
    include: ['tests/**/*.test.ts'],
  },
});
