import { shell } from '@codemirror/legacy-modes/mode/shell';

import { streamHighlighter } from './stream';

export const shellHighlighter = streamHighlighter(shell);
