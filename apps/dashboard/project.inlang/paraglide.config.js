import { defineConfig } from '@inlang/paraglide-js';

export default defineConfig({
    outdir: './src/paraglide',
    strategy: ['cookie', 'preferredLanguage', 'baseLocale'],
    cookieName: 'ptbk_locale',
    emitTsDeclarations: true,
    emitReadme: false,
    emitGitIgnore: false,
    emitPrettierIgnore: false,
});
