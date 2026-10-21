import { parser } from '@lezer/html';

import { lezerHighlighter } from './lezer';

export const htmlHighlighter = lezerHighlighter(parser);
