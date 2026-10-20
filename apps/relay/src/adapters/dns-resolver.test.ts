import { describeDnsResolver } from '../testing/dns-resolver-suite';
import { startFakeDnsServer } from '../testing/fake-dns-server';
import { createInMemoryDnsResolver } from './in-memory-dns-resolver';
import { createNodeDnsResolver } from './node-dns-resolver';

describeDnsResolver('in-memory', () => {
    const resolver = createInMemoryDnsResolver();
    return Promise.resolve({
        resolver,
        given: (hostname, scenario) => {
            resolver.setAnswer(hostname, scenario);
        },
        close: () => Promise.resolve(),
    });
});

describeDnsResolver('node (c-ares against a fake server)', async () => {
    const server = await startFakeDnsServer();
    return {
        resolver: createNodeDnsResolver({ servers: [server.address], timeoutMs: 500 }),
        given: (hostname, scenario) => {
            switch (scenario.kind) {
                case 'cname':
                    server.answer(hostname, { kind: 'cname', targets: [scenario.target] });
                    break;
                case 'none':
                    server.answer(hostname, { kind: 'nodata' });
                    break;
                case 'error':
                    server.answer(hostname, { kind: 'servfail' });
                    break;
            }
        },
        close: () => server.close(),
    };
});
