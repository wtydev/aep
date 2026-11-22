import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const pkg = (name: string) =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@aep/schema': pkg('schema'),
      '@aep/core': pkg('core'),
      '@aep/host': pkg('host'),
      '@aep/client': pkg('client'),
      '@aep/transport': pkg('transport'),
      '@aep/testing': pkg('testing'),
    },
  },
  test: {
    include: ['packages/*/src/**/*.test.ts', 'tests/**/*.test.ts'],
    testTimeout: 20000,
  },
});
