import type { RangiOptions } from 'comark/plugins/rangi'

export type ContentHighlightOptions = Pick<RangiOptions, 'languages' | 'theme'>
export type ContentHighlight = boolean | ContentHighlightOptions
