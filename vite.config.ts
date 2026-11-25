import { defineConfig } from 'vite-plus';

export default defineConfig({
  fmt: { singleQuote: true, printWidth: 100, ignorePatterns: ['**/*.md', 'package-lock.json'] },
  lint: { options: { typeAware: true, typeCheck: true, denyWarnings: true } },
  pack: {
    entry: ['src/main.ts'],
    format: 'esm',
    platform: 'node',
    target: 'node24',
    dts: false,
    fixedExtension: false,
  },
  test: { include: ['src/**/*.test.ts'], fsModuleCache: false },
});
