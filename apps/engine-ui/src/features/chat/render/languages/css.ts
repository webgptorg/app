import { parser } from '@lezer/css';

import { lezerHighlighter } from './lezer';

export const cssHighlighter = lezerHighlighter(parser);
