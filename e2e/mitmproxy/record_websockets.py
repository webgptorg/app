"""mitmproxy addon for the tls-inspecting-proxy scenario (X-02).

Publishes the proxy's CA certificate (never its key) for the engine to trust, and records every WebSocket message
the proxy intercepts, so the test can show it saw inside the engine's tunnel to the relay and that the tunnel's
binary frames still carry the browser's TLS records.
"""

import asyncio
import base64
import json
import os
import shutil
from pathlib import Path

from mitmproxy import ctx, http

SHARED = Path("/mitm")


class RecordWebSockets:
    def running(self) -> None:
        # mitmproxy's TLS addon creates the CA in its own `running` hook, which may come after this one.
        self._publishing = asyncio.get_running_loop().create_task(self._publish_ca_certificate())

    async def _publish_ca_certificate(self) -> None:
        certificate = Path(ctx.options.confdir).expanduser() / "mitmproxy-ca-cert.pem"
        while not certificate.exists():
            await asyncio.sleep(0.05)
        staged = SHARED / "ca-cert.pem.partial"
        shutil.copyfile(certificate, staged)
        os.chmod(staged, 0o644)
        # The healthcheck waits for the final name, so the engine never reads a half-written file.
        os.replace(staged, SHARED / "ca-cert.pem")

    def websocket_message(self, flow: http.HTTPFlow) -> None:
        assert flow.websocket is not None
        message = flow.websocket.messages[-1]
        record = {
            "host": flow.request.pretty_host,
            "path": flow.request.path,
            "fromClient": message.from_client,
            "binary": not message.is_text,
            "content": base64.b64encode(message.content).decode("ascii"),
        }
        with open(SHARED / "websocket-messages.jsonl", "a", encoding="utf-8") as log:
            log.write(json.dumps(record) + "\n")


addons = [RecordWebSockets()]
