import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // `src/` holds the unit tests (pure, no DOM, no processes). `tests/` holds
    // integration tests that need Node APIs — today the sync relay, spawned for
    // real over HTTP. They live outside `src` because `tsc` only type-checks the
    // app, and they need node builtins whose types are not installed.
    include: ['src/**/*.test.{ts,tsx}', 'tests/**/*.test.{ts,mts}'],
    // The vault and sync tests derive PBKDF2 keys with deliberately slow
    // parameters (several seconds each); the 5s default made them flake when the
    // files run in parallel. They are still fast enough to keep the suite snappy.
    testTimeout: 20000,
  },
});
