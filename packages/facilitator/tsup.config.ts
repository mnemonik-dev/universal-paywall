import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    cli: 'src/cli.ts',
    'session-cli': 'src/session-cli.ts',
    'eip3009/index': 'src/eip3009/index.ts',
  },
  format: ['esm'],
  target: 'node20',
  dts: true,
  sourcemap: true,
  clean: true,
  minify: false,
});
