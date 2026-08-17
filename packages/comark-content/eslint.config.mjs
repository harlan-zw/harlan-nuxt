import antfu from '@antfu/eslint-config'

export default antfu({
  type: 'lib',
  ignores: [
    // Template evaluated inside a browser automation harness. It relies on
    // injected globals and `__PLACEHOLDER__` tokens, so it is not valid standalone JS.
    'bench/site-harlanzw/browser-sample.js',
  ],
  rules: {
    'no-console': 'off',
    'no-use-before-define': 'off',
    'ts/explicit-function-return-type': 'off',
  },
})
