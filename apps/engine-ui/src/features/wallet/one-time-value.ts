/**
 * A password or field value on its way to the engine. It is handed over once and is empty afterwards, so whatever keeps a
 * mutation's variables (TanStack Query's mutation cache, devtools) never keeps the value. It serialises to nothing.
 */
export class OneTimeValue {
    #value: string | null;

    constructor(value: string) {
        this.#value = value;
    }

    take(): string {
        const value = this.#value ?? '';
        this.#value = null;
        return value;
    }

    toJSON(): Record<string, never> {
        return {};
    }
}
