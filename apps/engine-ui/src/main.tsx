import './app/zod-jitless';
import './styles.css';

import { bootstrap } from './app/bootstrap';

const container = document.getElementById('root');
if (container === null) {
    throw new Error('index.html has no #root element');
}
// No top-level await: it would turn off Rolldown's merging of common chunks into the entry, which keeps zod-jitless
// running before any schema is built and index.html down to one script.
void bootstrap(container, {
    document,
    location: window.location,
    fetch: (input, init) => fetch(input, init),
    cspScope: window,
});
