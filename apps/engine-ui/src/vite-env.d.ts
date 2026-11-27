declare global {
    /** The release version (`package.json`, or the dry-run version `pack` sets), replaced at build time. */
    const __PTBK_UI_VERSION__: string;

    interface ImportMetaEnv {
        /** `memory` swaps in the in-memory engine API client; honoured by the dev server only. */
        readonly VITE_ENGINE_API?: string;
        /** `full` advertises every capability on the in-memory engine; anything else only what Reborn has. */
        readonly VITE_ENGINE_PROFILE?: string;
        /** `pending` starts the in-memory engine before its setup, to work on onboarding. */
        readonly VITE_ENGINE_ONBOARDING?: string;
        /** `fresh` starts the in-memory engine empty, as a new engine is: to work on Home's next steps. */
        readonly VITE_ENGINE_SEED?: string;
        /** `1` in the `test:csp` build only: mounts `@ptbk/ui`'s gallery at `/__gallery`. */
        readonly VITE_UI_GALLERY?: string;
    }
}

export {};
