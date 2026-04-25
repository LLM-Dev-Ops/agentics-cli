/** @type {import('jest').Config} */
export default {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        useESM: true,
        // ADR-094 — pin compiler options ts-jest uses so `import.meta.url` (used
        // by phase2-coordinator and friends) compiles cleanly under ESM. The
        // project tsconfig already declares `module: NodeNext`, but ts-jest's
        // default-esm preset doesn't always inherit it; passing tsconfig
        // explicitly avoids the TS1343 false negative on import.meta.
        tsconfig: {
          module: 'esnext',
          target: 'es2022',
          isolatedModules: true,
          esModuleInterop: true,
          resolveJsonModule: true,
          moduleResolution: 'bundler',
        },
      },
    ],
  },
  testMatch: [
    '**/tests/**/*.test.ts',
    '**/tests/**/*.spec.ts',
  ],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/**/index.ts',
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
};
