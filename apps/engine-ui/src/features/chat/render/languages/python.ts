import { parser } from '@lezer/python';

import { lezerHighlighter } from './lezer';

export const pythonHighlighter = lezerHighlighter(parser);
