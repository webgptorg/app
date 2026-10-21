import { parser } from '@lezer/json';

import { lezerHighlighter } from './lezer';

export const jsonHighlighter = lezerHighlighter(parser);
