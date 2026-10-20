import { defineConfig } from '@inlang/paraglide-js';

export default defineConfig({
    outdir: './src/paraglide',
    // `custom-storage` is localStorage behind try/catch (src/app/locale-storage.ts): the built-in `localStorage`
    // strategy reads it unguarded on every message call, so blocked site data would break every string.
    strategy: ['custom-storage', 'preferredLanguage', 'baseLocale'],
    emitTsDeclarations: true,
    emitReadme: false,
    emitGitIgnore: false,
    emitPrettierIgnore: false,
});
