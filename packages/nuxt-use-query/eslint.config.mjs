import antfu from '@antfu/eslint-config'
import harlanzw from 'eslint-plugin-harlanzw'

export default antfu({
  ignores: [
    'test/fixture/**',
    'playground/**',
  ],
  rules: {
    'node/prefer-global/process': 'off',
    'node/prefer-global/buffer': 'off',
    'no-use-before-define': 'off',
  },
}, ...harlanzw())
