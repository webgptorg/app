#!/bin/sh
# The engine LAN's only router (X-02). It joins the stack network (the "internet" side, where relays, DNS and the
# browser live) and engine-lan, an internal network nothing else can route into. GATEWAY_POLICY picks what the engine
# may reach:
#   nat         any outbound connection, masqueraded behind the gateway's address; nothing inbound
#   egress-443  outbound TCP 443 and DNS to the stack's resolver only, as on a locked-down corporate network
#   closed      nothing at all: the engine's only way out is a proxy on its LAN (connect-proxy and
#               tls-inspecting-proxy overlays)
# None of the policies forwards a connection that starts outside: there are no DNAT rules, and FORWARD only lets
# replies back in. Rules are applied once; then the script drops every privilege and idles.
set -eu

: "${GATEWAY_POLICY:?}" "${ENGINE_LAN_SUBNET:?}" "${GATEWAY_PUBLIC_IP:?}" "${GATEWAY_LAN_IP:?}" "${DNS_IP:?}"

# Docker names interfaces in attach order, which compose does not promise; find them by address instead.
interface_with() {
    ip -o -4 addr show | awk -v ip="$1" '{ split($4, a, "/"); if (a[1] == ip) print $2 }'
}
wan=$(interface_with "$GATEWAY_PUBLIC_IP")
lan=$(interface_with "$GATEWAY_LAN_IP")
if [ -z "$wan" ] || [ -z "$lan" ]; then
    echo "gateway: missing an interface (wan=${wan:-none}, lan=${lan:-none})" >&2
    exit 1
fi

# Default deny in both directions through the gateway, and to the gateway itself: it serves nothing, so a probe of its
# public address finds no open port (it may answer with a reset; it never forwards).
iptables -P FORWARD DROP
iptables -P INPUT DROP
iptables -A INPUT -i lo -j ACCEPT
iptables -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT

# Replies to connections the engine opened. This is the only rule that lets anything from the wan side in.
iptables -A FORWARD -i "$wan" -o "$lan" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT

case "$GATEWAY_POLICY" in
    nat)
        iptables -A FORWARD -i "$lan" -o "$wan" -s "$ENGINE_LAN_SUBNET" -j ACCEPT
        ;;
    egress-443)
        iptables -A FORWARD -i "$lan" -o "$wan" -s "$ENGINE_LAN_SUBNET" -p tcp --dport 443 -j ACCEPT
        # Relay hostnames must resolve, but only through the stack's own resolver, never a resolver of the engine's
        # choosing (DNS is a classic way around an egress filter).
        iptables -A FORWARD -i "$lan" -o "$wan" -s "$ENGINE_LAN_SUBNET" -d "$DNS_IP" -p udp --dport 53 -j ACCEPT
        iptables -A FORWARD -i "$lan" -o "$wan" -s "$ENGINE_LAN_SUBNET" -d "$DNS_IP" -p tcp --dport 53 -j ACCEPT
        ;;
    closed) ;;
    *)
        echo "gateway: unknown GATEWAY_POLICY ${GATEWAY_POLICY}" >&2
        exit 1
        ;;
esac

# The engine's private addresses never leave the LAN: relays see the gateway's address, as behind a home router.
iptables -t nat -A POSTROUTING -s "$ENGINE_LAN_SUBNET" -o "$wan" -j MASQUERADE

echo "gateway: policy ${GATEWAY_POLICY}, lan ${lan}, wan ${wan}"
touch /tmp/gateway-ready
exec setpriv --reuid=65534 --regid=65534 --clear-groups --inh-caps=-all --no-new-privs sleep infinity
