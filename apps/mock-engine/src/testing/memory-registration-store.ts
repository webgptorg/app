import type { Registration, RegistrationStore } from '../domain/registration/registration';

export interface MemoryRegistrationStore extends RegistrationStore {
    /** Forgets the registration, as if `registration.json` were deleted. */
    clear(): void;
}

export function createMemoryRegistrationStore(initial: Registration | null = null): MemoryRegistrationStore {
    let stored = initial;
    return {
        load: () => Promise.resolve(stored),
        save(registration) {
            stored = registration;
            return Promise.resolve();
        },
        clear() {
            stored = null;
        },
    };
}
