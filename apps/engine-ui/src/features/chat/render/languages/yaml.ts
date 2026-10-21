import { parser } from '@lezer/yaml';

import { lezerHighlighter } from './lezer';

export const yamlHighlighter = lezerHighlighter(parser);
