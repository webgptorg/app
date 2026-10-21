import { standardSQL } from '@codemirror/legacy-modes/mode/sql';

import { streamHighlighter } from './stream';

export const sqlHighlighter = streamHighlighter(standardSQL);
