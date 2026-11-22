import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const pkg = (name: string) =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@wty.dev/aep-schema': pkg('schema'),
      '@wty.dev/aep-core': pkg('core'),
      '@wty.dev/aep-host': pkg('host'),
      '@wty.dev/aep-client': pkg('client'),
      '@wty.dev/aep-transport': pkg('transport'),
      '@wty.dev/aep-testing': pkg('testing'),
    },
  },
  test: {
    include: ['packages/*/src/**/*.test.ts', 'tests/**/*.test.ts'],
    testTimeout: 20000,
  },
});
