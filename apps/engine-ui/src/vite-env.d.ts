declare global {
    interface ImportMetaEnv {
        /** `memory` swaps in the in-memory engine API client; honoured by the dev server only. */
        readonly VITE_ENGINE_API?: string;
    }
}

export {};
