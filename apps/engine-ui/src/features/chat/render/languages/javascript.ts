import { parser } from '@lezer/javascript';

import { lezerHighlighter } from './lezer';

export const javascriptHighlighter = lezerHighlighter(parser);
export const jsxHighlighter = lezerHighlighter(parser.configure({ dialect: 'jsx' }));
export const typescriptHighlighter = lezerHighlighter(parser.configure({ dialect: 'ts' }));
export const tsxHighlighter = lezerHighlighter(parser.configure({ dialect: 'ts jsx' }));
