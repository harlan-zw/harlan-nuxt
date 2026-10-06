import antfu from '@antfu/eslint-config'

export default antfu({
  type: 'lib',
  ignores: ['**/.wrangler/**'],
  rules: {
    'no-console': 'off',
    'ts/explicit-function-return-type': 'off',
  },
})
