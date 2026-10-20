export const engineKeys = {
    all: ['engine'] as const,
    info: () => [...engineKeys.all, 'info'] as const,
};
