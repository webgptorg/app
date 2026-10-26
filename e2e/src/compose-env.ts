// Compose's variable interpolation, as far as our compose files use it, so tests can read a compose file as Docker
// would without needing Docker (vitest.config.ts). Only node: imports.

const VARIABLE = /\$\$|\$\{([A-Z_][A-Z0-9_]*)(?::-([^}]*))?\}/g;

/** `${NAME}` and `${NAME:-default}` from `env` (unset or empty takes the default), `$$` as a literal `$`. */
export function interpolate(text: string, env: Readonly<Record<string, string | undefined>> = {}): string {
    return text.replace(VARIABLE, (match, name: string | undefined, fallback: string | undefined) => {
        if (name === undefined) return match === '$$' ? '$' : match;
        const value = env[name];
        return value === undefined || value === '' ? (fallback ?? '') : value;
    });
}
