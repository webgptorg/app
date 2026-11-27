// Vite's `?raw` suffix imports a file's text, so the installer scripts stay real shell files.
declare module '*?raw' {
    const text: string;
    // eslint-disable-next-line no-restricted-exports -- the shape Vite gives these modules
    export default text;
}
