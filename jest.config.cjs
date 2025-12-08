module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  //maxWorkers: 1, // Commented out to allow parallel test execution
  roots: ['<rootDir>/tests', '<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.ts', '**/?(*.)+(spec|test).ts'],
  transform: {
    '^.+\\.[tj]s$': [
      'ts-jest',
      {
        tsconfig: {
          module: 'commonjs',
          esModuleInterop: true,
          allowSyntheticDefaultImports: true,
          allowJs: true,
        },
      },
    ],
  },
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.d.ts', '!src/types/**', '!src/**/index.ts'],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  moduleNameMapper: {
    '^(\.{1,2}/.*)\.js': '$1',
  },
  transformIgnorePatterns: ['node_modules/(?!@noble)'],
  setupFilesAfterEnv: ['./tests/setup.ts'],
};
