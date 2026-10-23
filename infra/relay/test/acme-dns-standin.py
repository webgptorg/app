"""Stand-ins for the VM test (vm-test.sh): the authoritative DNS of a test domain and the part of the Cloudflare API
that lego's cloudflare provider calls, so the relay host's real certificate unit can issue against Pebble offline.

The token sees only the challenge zone, as in production (ADR 0011). The relay's _acme-challenge name is a CNAME
into that zone, so issuance succeeds only if lego follows the CNAME and writes the record where the token may.
TXT records created through the API are served by the DNS side. Python standard library only.

    acme-dns-standin.py <address> <token file> <tls cert> <tls key> <challenge zone> <relay zone> <alias>=<target>
"""

import itertools
import json
import socket
import ssl
import struct
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

A, NS, CNAME, SOA, TXT = 1, 2, 5, 6, 16
ZONE_ID = "0123456789abcdef0123456789abcdef"

address, token_file, cert_file, key_file, challenge_zone, relay_zone = sys.argv[1:7]
aliases = dict(arg.lower().split("=", 1) for arg in sys.argv[7:])
with open(token_file) as f:
    token = f.read().strip()

apexes = {challenge_zone, relay_zone}
nameserver = "ns." + challenge_zone
txt_records = {}
record_ids = itertools.count(1)
lock = threading.Lock()


def log(*parts):
    print(*parts, flush=True)


def encode_name(name):
    return b"".join(bytes([len(label)]) + label.encode() for label in name.rstrip(".").split(".") if label) + b"\0"


def record(name, rtype, rdata, ttl=1):
    return encode_name(name) + struct.pack("!HHIH", rtype, 1, ttl, len(rdata)) + rdata


def soa(apex):
    rdata = encode_name(nameserver) + encode_name("hostmaster." + apex) + struct.pack("!IIIII", 1, 60, 60, 600, 1)
    return record(apex, SOA, rdata)


def records_at(name, qtype):
    if qtype in (SOA, 255) and name in apexes:
        return [soa(name)]
    if qtype == NS and name in apexes:
        return [record(name, NS, encode_name(nameserver))]
    if qtype == A and name == nameserver:
        return [record(name, A, socket.inet_aton(address))]
    if qtype == TXT:
        with lock:
            values = [value for (owner, value) in txt_records.values() if owner == name]
        return [record(name, TXT, bytes([len(v)]) + v.encode()) for v in values]
    return []


def answer(query):
    ident, flags = struct.unpack("!HH", query[:4])
    end = 12
    labels = []
    while query[end]:
        labels.append(query[end + 1 : end + 1 + query[end]].decode().lower())
        end += 1 + query[end]
    qtype = struct.unpack("!H", query[end + 1 : end + 3])[0]
    question = query[12 : end + 5]
    name = ".".join(labels)

    answers = []
    if name in aliases and qtype != CNAME:
        # Answered with the target's records too, as a recursive resolver would, so Pebble's lookup needs no chase.
        answers = [record(name, CNAME, encode_name(aliases[name]))] + records_at(aliases[name], qtype)
    elif name in aliases:
        answers = [record(name, CNAME, encode_name(aliases[name]))]
    else:
        answers = records_at(name, qtype)
    zone = next((apex for apex in apexes if name == apex or name.endswith("." + apex)), None)
    authority = [soa(zone)] if not answers and zone else []
    header = struct.pack("!HHHHHH", ident, 0x8400 | (flags & 0x0100), 1, len(answers), len(authority), 0)
    log("dns", name, qtype, "->", len(answers), "answers")
    return header + question + b"".join(answers) + b"".join(authority)


def serve_dns_udp():
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind((address, 53))
    while True:
        query, peer = sock.recvfrom(4096)
        try:
            sock.sendto(answer(query), peer)
        except (IndexError, struct.error, UnicodeDecodeError):
            pass


def serve_dns_connection(conn):
    with conn:
        conn.settimeout(5)
        stream = conn.makefile("rb")
        try:
            while prefix := stream.read(2):
                response = answer(stream.read(struct.unpack("!H", prefix)[0]))
                conn.sendall(struct.pack("!H", len(response)) + response)
        except (OSError, IndexError, struct.error, UnicodeDecodeError):
            pass


# Pebble asks over TCP.
def serve_dns_tcp():
    server = socket.create_server((address, 53))
    while True:
        conn, _ = server.accept()
        threading.Thread(target=serve_dns_connection, args=(conn,), daemon=True).start()


class CloudflareApi(BaseHTTPRequestHandler):
    def reply(self, status, result=None, errors=()):
        body = json.dumps({"success": status < 300, "errors": list(errors), "messages": [], "result": result}).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def authorized(self):
        if self.headers.get("Authorization") == "Bearer " + token:
            return True
        self.reply(403, errors=[{"code": 9109, "message": "Invalid access token"}])
        return False

    def do_GET(self):
        url = urlparse(self.path)
        log("api GET", self.path)
        if url.path != "/client/v4/zones":
            return self.reply(404, errors=[{"code": 7003, "message": "No route"}])
        if not self.authorized():
            return None
        names = parse_qs(url.query).get("name", [])
        zones = [{"id": ZONE_ID, "name": challenge_zone}] if names == [challenge_zone] else []
        return self.reply(200, zones)

    def do_POST(self):
        log("api POST", self.path)
        if self.path != f"/client/v4/zones/{ZONE_ID}/dns_records":
            return self.reply(404, errors=[{"code": 7003, "message": "No route"}])
        if not self.authorized():
            return None
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        name = body["name"].lower().rstrip(".")
        if body["type"] != "TXT" or not (name == challenge_zone or name.endswith("." + challenge_zone)):
            return self.reply(400, errors=[{"code": 9000, "message": "Record outside the zone"}])
        with lock:
            record_id = f"{next(record_ids):032x}"
            txt_records[record_id] = (name, body["content"].strip('"'))
        log("api created TXT", name)
        return self.reply(200, {"id": record_id, **body})

    def do_DELETE(self):
        log("api DELETE", self.path)
        prefix = f"/client/v4/zones/{ZONE_ID}/dns_records/"
        if not self.path.startswith(prefix):
            return self.reply(404, errors=[{"code": 7003, "message": "No route"}])
        if not self.authorized():
            return None
        with lock:
            removed = txt_records.pop(self.path[len(prefix) :], None)
        if removed is None:
            return self.reply(404, errors=[{"code": 81044, "message": "Record not found"}])
        return self.reply(200, {"id": self.path[len(prefix) :]})

    def log_message(self, *args):
        pass


threading.Thread(target=serve_dns_udp, daemon=True).start()
threading.Thread(target=serve_dns_tcp, daemon=True).start()
api = ThreadingHTTPServer((address, 443), CloudflareApi)
context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain(cert_file, key_file)
api.socket = context.wrap_socket(api.socket, server_side=True)
log("listening on", address)
api.serve_forever()
