import type { Page } from '@playwright/test';

/**
 * Everything the page's origin keeps in the browser, as text: localStorage, sessionStorage and every IndexedDB record,
 * so a test can show a secret never landed there. Cookies are the gateway's session only and HttpOnly.
 */
export async function browserStorageText(page: Page): Promise<string> {
    return page.evaluate(async () => {
        const dump = (storage: Storage): Record<string, string | null> =>
            Object.fromEntries(
                Array.from({ length: storage.length }, (_, index) => storage.key(index) ?? '').map((key) => [
                    key,
                    storage.getItem(key),
                ]),
            );
        const readDatabase = (name: string): Promise<Record<string, unknown[]>> =>
            new Promise((resolve, reject) => {
                const opening = indexedDB.open(name);
                opening.onerror = () => {
                    reject(new Error(`IndexedDB ${name} did not open`));
                };
                opening.onsuccess = () => {
                    const database = opening.result;
                    const stores = Array.from(database.objectStoreNames);
                    if (stores.length === 0) {
                        database.close();
                        resolve({});
                        return;
                    }
                    const transaction = database.transaction(stores, 'readonly');
                    const records: Record<string, unknown[]> = {};
                    for (const store of stores) {
                        const all = transaction.objectStore(store).getAll();
                        all.onsuccess = () => {
                            records[store] = all.result;
                        };
                    }
                    transaction.oncomplete = () => {
                        database.close();
                        resolve(records);
                    };
                    transaction.onerror = () => {
                        reject(new Error(`IndexedDB ${name} could not be read`));
                    };
                };
            });
        const databases = await indexedDB.databases();
        const indexed: Record<string, unknown> = {};
        for (const { name } of databases) {
            if (name !== undefined) indexed[name] = await readDatabase(name);
        }
        return JSON.stringify({ local: dump(localStorage), session: dump(sessionStorage), indexed });
    });
}
