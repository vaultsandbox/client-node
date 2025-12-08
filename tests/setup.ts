/**
 * Global Jest setup file.
 *
 * This file is executed by Jest before running the test suites.
 * It is used to configure the environment, such as loading environment variables
 * from a .env file and setting up console log capturing for failed tests.
 */
import 'dotenv/config';

const originalConsoleLog = console.log;
const originalConsoleWarn = console.warn;
const originalConsoleError = console.error;
const originalConsoleDebug = console.debug;
const originalConsoleInfo = console.info;

let consoleOutput: { type: 'log' | 'warn' | 'error' | 'debug' | 'info'; message: unknown[] }[] = [];

const mockedConsole =
  (type: 'log' | 'warn' | 'error' | 'debug' | 'info') =>
  (...args: unknown[]) => {
    consoleOutput.push({ type, message: args });
  };

beforeAll(() => {
  console.log = mockedConsole('log');
  console.warn = mockedConsole('warn');
  console.error = mockedConsole('error');
  console.debug = mockedConsole('debug');
  console.info = mockedConsole('info');
});

afterEach(() => {
  if (
    expect.getState().currentTestName &&
    (expect.getState().suppressedErrors.length > 0 ||
      (expect.getState().assertionCalls > 0 && expect.getState().numPassingAsserts < expect.getState().assertionCalls))
  ) {
    // Test failed, so we print the logs
    consoleOutput.forEach(({ type, message }) => {
      switch (type) {
        case 'log':
          originalConsoleLog.apply(console, message);
          break;
        case 'warn':
          originalConsoleWarn.apply(console, message);
          break;
        case 'error':
          originalConsoleError.apply(console, message);
          break;
        case 'debug':
          originalConsoleDebug.apply(console, message);
          break;
        case 'info':
          originalConsoleInfo.apply(console, message);
          break;
      }
    });
  }
  // Clear logs for the next test
  consoleOutput = [];
});

afterAll(() => {
  console.log = originalConsoleLog;
  console.warn = originalConsoleWarn;
  console.error = originalConsoleError;
  console.debug = originalConsoleDebug;
  console.info = originalConsoleInfo;
});
