import antfu from '@antfu/eslint-config'

export default antfu({
  type: 'lib',
  ignores: ['.check-types-*/**', '.execution-*/**', 'tests/fixtures/.dev-*/**'],
  rules: {
    'no-console': 'off',
    'ts/explicit-function-return-type': 'off',
  },
})
