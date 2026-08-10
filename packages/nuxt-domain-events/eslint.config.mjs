import antfu from '@antfu/eslint-config'

export default antfu({
  type: 'lib',
  rules: {
    'no-use-before-define': 'off',
    'ts/explicit-function-return-type': 'off',
  },
})
