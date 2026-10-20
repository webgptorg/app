declare global {
    interface ImportMetaEnv {
        /** `memory` swaps in the in-memory engine API client; honoured by the dev server only. */
        readonly VITE_ENGINE_API?: string;
        /** `1` in the `test:csp` build only: mounts `@ptbk/ui`'s gallery at `/__gallery`. */
        readonly VITE_UI_GALLERY?: string;
    }
}

export {};
