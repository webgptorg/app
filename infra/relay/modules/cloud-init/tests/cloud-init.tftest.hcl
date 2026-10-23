# Runs offline: the module has no provider. Public keys of throwaway key pairs and documentation addresses only.

variables {
  name          = "relay-fsn"
  relay_domain  = "relays.example"
  engine_domain = "engines.example"
  registry_url  = "https://app.example"
  acme_email    = "ops@example.com"
  admins = {
    ada = ["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIODl1HFc9w2tQEYLZv2a7Q6WsBdDk0Rgoxk/YQuqGbj+ ada"]
  }
  deploy_key    = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEAvFcF9TjUmm57Av3oVnBfv6lwzliXetJmpL5iZ/p0m deploy"
  ssh_allowlist = ["198.51.100.0/24", "2001:db8:1::/48"]
  reboot_time   = "23:30"
}

run "hardens_ssh_and_users" {
  command = apply

  assert {
    condition     = local.cloud_config.ssh_pwauth == false && local.cloud_config.disable_root == true
    error_message = "Password SSH and root login are off from the first boot."
  }

  assert {
    condition     = alltrue([for user in local.cloud_config.users : user.lock_passwd == true])
    error_message = "No user has a password."
  }

  assert {
    condition = [for user in local.cloud_config.users : user.ssh_authorized_keys if user.name == "ptbk-deploy"][0] == [
      "restrict,command=\"sudo -n /usr/local/sbin/ptbk-relay-deploy\" ${var.deploy_key}"
    ]
    error_message = "The deploy key can only run the forced deploy command, with every forwarding restricted."
  }

  assert {
    condition     = strcontains(local.files["/etc/ssh/sshd_config.d/10-ptbk-relay.conf"], "PermitRootLogin no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\n")
    error_message = "sshd refuses root and passwords."
  }

  assert {
    condition     = strcontains(local.files["/etc/ssh/sshd_config.d/10-ptbk-relay.conf"], "AllowUsers ada ptbk-deploy\n")
    error_message = "Only the named admins and the deploy user may log in."
  }

  assert {
    condition     = strcontains(local.files["/etc/sudoers.d/ptbk-deploy"], "ptbk-deploy ALL=(root) NOPASSWD: /usr/local/sbin/ptbk-relay-deploy\n")
    error_message = "The deploy user may run exactly the deploy command as root."
  }
}

run "firewall_admits_443_and_ssh_from_the_allowlist" {
  command = apply

  assert {
    condition     = strcontains(local.files["/etc/nftables.conf"], "elements = { 198.51.100.0/24 }") && strcontains(local.files["/etc/nftables.conf"], "elements = { 2001:db8:1::/48 }")
    error_message = "The allowlist is split by family into the SSH sets."
  }

  assert {
    condition     = length(regexall("policy drop;", local.files["/etc/nftables.conf"])) == 3
    error_message = "Input, forward and output drop by default."
  }

  assert {
    condition     = toset(regexall("tcp dport ([0-9]+)", local.files["/etc/nftables.conf"])) == toset([["443"], ["22"], ["80"]])
    error_message = "Only 443 and 22 are admitted inbound (80 appears only in the output chain)."
  }
}

run "an_ipv4_only_allowlist_leaves_the_ipv6_set_empty" {
  command = apply

  variables {
    ssh_allowlist = ["203.0.113.7/32"]
  }

  assert {
    condition     = length(regexall("elements =", local.files["/etc/nftables.conf"])) == 1
    error_message = "An empty set has no elements line (nft refuses an empty one)."
  }
}

run "relay_environment_holds_no_secret" {
  command = apply

  assert {
    condition     = strcontains(local.files["/etc/ptbk-relay/relay.env"], "RELAY_REGISTRY_TOKEN_FILE=/run/credentials/relay/registry-token\n")
    error_message = "The registry token arrives as a credential file."
  }

  assert {
    condition     = strcontains(local.files["/etc/ptbk-relay/relay.env"], "RELAY_METRICS_TOKEN_FILE=/run/credentials/relay/metrics-token\n")
    error_message = "The metrics token arrives as a credential file."
  }

  assert {
    condition     = !strcontains(output.user_data, "RELAY_REGISTRY_TOKEN=") && !strcontains(output.user_data, "ptbk_rt_") && !strcontains(output.user_data, "ptbk_mt_") && !strcontains(output.user_data, "PRIVATE KEY")
    error_message = "No token or private key is ever part of the user data."
  }

  assert {
    condition     = strcontains(local.files["/etc/ptbk-relay/relay.env"], "RELAY_HOSTNAME=relay-fsn.relays.example\nRELAY_ENGINE_DOMAIN=engines.example\n")
    error_message = "The relay knows its own hostname and the engine domain."
  }

  assert {
    condition     = strcontains(local.files["/etc/ptbk-relay/relay.env"], "RELAY_DNS_SERVERS=127.0.0.1\n")
    error_message = "The relay resolves through the local validating resolver."
  }
}

run "sizes_the_relay" {
  command = apply

  assert {
    condition     = local.files["/etc/ptbk-relay/limits.env"] == "# Container sizing for ptbk-relay.service. The V8 heap stays well below the memory limit: socket buffers and the\n# relay's own buffers (RELAY_MEMORY_BUDGET_BYTES) live outside it.\nPTBK_RELAY_MEMORY_MAX=3072m\nPTBK_RELAY_HEAP_MIB=1024\nPTBK_RELAY_NOFILE=65536\n"
    error_message = "Memory, heap and file-descriptor limits are explicit."
  }

  assert {
    condition     = strcontains(local.files["/etc/ptbk-relay/relay.env"], "RELAY_MAX_CONNECTIONS=10000\nRELAY_MEMORY_BUDGET_BYTES=1073741824\n")
    error_message = "The relay's own limits match the container sizing."
  }
}

run "staggers_reboot_and_renewal" {
  command = apply

  assert {
    condition     = strcontains(local.files["/etc/apt/apt.conf.d/52ptbk-relay-unattended-upgrades"], "Unattended-Upgrade::Automatic-Reboot-Time \"23:30\";")
    error_message = "Unattended upgrades reboot in this host's window."
  }

  assert {
    condition     = strcontains(local.files["/etc/systemd/system/ptbk-relay-cert.timer"], "OnCalendar=*-*-* 00:30:00 UTC\n")
    error_message = "The certificate renewal runs an hour after the reboot window, across midnight."
  }
}

run "keeps_logs_seven_days" {
  command = apply

  assert {
    condition     = strcontains(local.files["/etc/systemd/journald.conf.d/ptbk-relay.conf"], "Storage=persistent\nMaxRetentionSec=7day\n")
    error_message = "journald keeps engine IPs and tunnel times for at most 7 days."
  }
}

run "extra_relay_settings_pass_through" {
  command = apply

  variables {
    relay_settings = { RELAY_MAX_TUNNELS_PER_IP = "64", LOG_LEVEL = "warn" }
  }

  assert {
    condition     = strcontains(local.files["/etc/ptbk-relay/relay.env"], "LOG_LEVEL=warn\nRELAY_MAX_TUNNELS_PER_IP=64\n")
    error_message = "Tuned limits reach the relay."
  }
}

run "refuses_a_relay_hostname_under_the_engine_domain" {
  command = plan

  variables {
    relay_domain = "relays.engines.example"
  }

  expect_failures = [output.user_data]
}

run "refuses_a_relay_setting_the_module_owns" {
  command = plan

  variables {
    relay_settings = { RELAY_REGISTRY_TOKEN = "ptbk_rt_x" }
  }

  expect_failures = [var.relay_settings]
}

run "refuses_placeholders" {
  command = plan

  variables {
    relay_domain  = "<staging-zone>"
    engine_domain = "<engine-domain>"
    registry_url  = "https://app.<staging-zone>"
    acme_email    = "<ops-email>"
    admins        = { "<admin-name>" = ["<admin-ssh-public-key>"] }
    deploy_key    = "<deploy-ssh-public-key>"
    ssh_allowlist = ["<admin-network-cidr>"]
  }

  expect_failures = [
    var.relay_domain, var.engine_domain, var.registry_url, var.acme_email, var.admins, var.deploy_key, var.ssh_allowlist,
  ]
}

run "refuses_ssh_open_to_the_world" {
  command = plan

  variables {
    ssh_allowlist = ["0.0.0.0/0"]
  }

  expect_failures = [var.ssh_allowlist]
}

run "refuses_a_non_canonical_cidr" {
  command = plan

  variables {
    ssh_allowlist = ["198.51.100.7/24"]
  }

  expect_failures = [var.ssh_allowlist]
}

run "refuses_an_empty_allowlist" {
  command = plan

  variables {
    ssh_allowlist = []
  }

  expect_failures = [var.ssh_allowlist]
}

run "refuses_rsa_and_keys_with_options" {
  command = plan

  variables {
    admins     = { ada = ["ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQ ada"] }
    deploy_key = "command=\"/bin/sh\" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEAvFcF9TjUmm57Av3oVnBfv6lwzliXetJmpL5iZ/p0m"
  }

  expect_failures = [var.admins, var.deploy_key]
}

run "refuses_a_reserved_admin_name" {
  command = plan

  variables {
    admins = { root = ["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIODl1HFc9w2tQEYLZv2a7Q6WsBdDk0Rgoxk/YQuqGbj+"] }
  }

  expect_failures = [var.admins]
}

run "refuses_a_heap_that_crowds_out_the_buffers" {
  command = plan

  variables {
    heap_mib = 2048
  }

  expect_failures = [output.user_data]
}

run "refuses_too_few_file_descriptors" {
  command = plan

  variables {
    max_connections = 20000
  }

  expect_failures = [output.user_data]
}
