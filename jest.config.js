/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  testEnvironment: 'node',
  transform: { '^.+\\.tsx?$': 'ts-jest' },
  testMatch: ['**/test/**/*.test.ts'],
  moduleFileExtensions: ['ts', 'tsx', 'js'],
};
