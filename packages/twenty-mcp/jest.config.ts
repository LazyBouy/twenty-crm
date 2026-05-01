import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: 'src',
  testMatch: ['**/__tests__/**/*.test.ts'],
  // Integration tests gate themselves on TWENTY_MCP_INTEGRATION env at runtime,
  // but we exclude the directory by default to skip ts-jest compilation time
  // when not needed. Set INCLUDE_INTEGRATION=1 (or run jest with --testPathPattern)
  // to compile them.
  testPathIgnorePatterns: process.env.INCLUDE_INTEGRATION === '1' ? [] : ['/integration/'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/../tsconfig.json' }],
  },
  clearMocks: true,
};

export default config;
