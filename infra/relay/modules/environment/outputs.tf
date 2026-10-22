output "relays" {
  description = "Per relay: its hostname and addresses, for I-02's relays variable and the DNS records."
  value = {
    for name, server in hcloud_server.relay : name => {
      hostname = module.cloud_init[name].hostname
      ipv4     = server.ipv4_address
      ipv6     = server.ipv6_address
    }
  }
}
