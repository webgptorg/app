import { parser } from '@lezer/markdown';

import { lezerHighlighter } from './lezer';

export const markdownHighlighter = lezerHighlighter(parser);
