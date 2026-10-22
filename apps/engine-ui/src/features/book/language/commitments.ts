/**
 * Commitment keywords the editor highlights when the engine does not list its own. Multi-word commitments are listed
 * whole; `META` takes any upper-case key after it (`META COLOR`, `META IMAGE`). A keyword missing here only loses its
 * colour: the engine's diagnostics still decide what is valid.
 */
export const BUILT_IN_COMMITMENTS: readonly string[] = [
    'PERSONA',
    'KNOWLEDGE',
    'RULE',
    'RULES',
    'STYLE',
    'GOAL',
    'META',
    'INITIAL MESSAGE',
    'USER MESSAGE',
    'AGENT MESSAGE',
    'MESSAGE',
    'MODEL',
    'ACTION',
    'NOTE',
    'SAMPLE',
    'EXAMPLE',
    'SCENARIO',
    'FORMAT',
    'MEMORY',
    'LANGUAGE',
    'CONTEXT',
    'TEAM',
    'FROM',
    'IMPORT',
    'USE BROWSER',
    'USE SEARCH ENGINE',
    'USE MCP',
    'OPEN',
    'CLOSED',
    'DELETE',
];
