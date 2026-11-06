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
    condition     = [for user in local.cloud_config.users : user.name if can(user.ssh_authorized_keys)] == ["ada"]
    error_message = "Only the named admins have SSH keys: relays pull their deploys, so there is no deploy key (I-03)."
  }

  assert {
    condition     = strcontains(local.files["/etc/ssh/sshd_config.d/10-ptbk-relay.conf"], "PermitRootLogin no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\n")
    error_message = "sshd refuses root and passwords."
  }

  assert {
    condition     = strcontains(local.files["/etc/ssh/sshd_config.d/10-ptbk-relay.conf"], "AllowUsers ada\n")
    error_message = "Only the named admins may log in."
  }

  assert {
    condition     = length([for path in keys(local.files) : path if strcontains(path, "sudoers")]) == 0
    error_message = "No sudoers rule besides the admins' own."
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

run "ssh_from_anywhere_opens_22_to_every_address" {
  command = apply

  variables {
    ssh_from_anywhere = true
    ssh_allowlist     = []
  }

  assert {
    condition     = strcontains(local.files["/etc/nftables.conf"], "elements = { 0.0.0.0/0 }") && strcontains(local.files["/etc/nftables.conf"], "elements = { ::/0 }")
    error_message = "Both SSH sets admit every address."
  }

  assert {
    condition     = strcontains(local.files["/etc/ssh/sshd_config.d/10-ptbk-relay.conf"], "AuthenticationMethods publickey\n") && strcontains(local.files["/etc/ssh/sshd_config.d/10-ptbk-relay.conf"], "MaxAuthTries 3\n") && strcontains(local.files["/etc/ssh/sshd_config.d/10-ptbk-relay.conf"], "LoginGraceTime 20\n")
    error_message = "Open SSH is still keys only, with few tries and a short login window."
  }
}

run "relay_environment_holds_no_secret" {
  command = apply

  assert {
    condition     = strcontains(local.files["/etc/ptbk-relay/relay.env"], "RELAY_REGISTRY_TOKEN_FILE=/run/credentials/relay/registry-token\n")
    error_message = "The registry token arrives as a credential file."
  }

  assert {
    condition     = !strcontains(local.files["/etc/ptbk-relay/relay.env"], "RELAY_METRICS_TOKEN") && strcontains(local.files["/etc/systemd/system/ptbk-relay.service"], "echo RELAY_METRICS_TOKEN_FILE=/run/credentials/relay/metrics-token")
    error_message = "The metrics token is optional: the unit hands it over as a file only when it exists."
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

run "deploys_only_what_release_relay_signed_on_main" {
  command = apply

  assert {
    condition     = strcontains(local.files["/etc/ptbk-relay/deploy.env"], "\nPTBK_DEPLOY_CERT_IDENTITY=https://github.com/webgptorg/app/.github/workflows/release-relay.yml@refs/heads/main\n")
    error_message = "A relay accepts images signed by release-relay.yml on main, by exact identity."
  }

  assert {
    condition     = strcontains(local.files["/etc/ptbk-relay/deploy.env"], "\nPTBK_DEPLOY_CERT_OIDC_ISSUER=https://token.actions.githubusercontent.com\nPTBK_DEPLOY_CERT_REPOSITORY=webgptorg/app\n")
    error_message = "The issuer and the repository extension are pinned too."
  }

  assert {
    condition     = strcontains(local.files["/etc/ptbk-relay/deploy.env"], "\nPTBK_DEPLOY_TRUSTED_ROOT=\n") && strcontains(local.files["/etc/ptbk-relay/deploy.env"], "\nPTBK_DEPLOY_IMAGE_REPOSITORY=ghcr.io/webgptorg/relay\n")
    error_message = "Production verifies against Sigstore's public-good root and pulls only the relay repository."
  }

  assert {
    condition     = length(regexall("identity-regexp", join("\n", values(local.files)))) == 0
    error_message = "No host file uses an identity pattern (ADR 0014)."
  }

  assert {
    condition     = strcontains(local.files["/etc/ptbk-relay/deploy.env"], "\nPTBK_DEPLOY_MAX_DOWNGRADE_DAYS=30\n")
    error_message = "An image built more than 30 days before the running one is refused."
  }

  assert {
    condition     = contains(local.cloud_config.runcmd, ["systemctl", "enable", "ptbk-relay.service", "ptbk-relay-cert.timer", "ptbk-relay-deploy.timer"]) && strcontains(local.files["/etc/systemd/system/ptbk-relay-deploy.service"], "LoadCredential=registry-auth:/etc/ptbk-relay/credentials/registry-auth\n")
    error_message = "The relay pulls its deploys on a timer, with the read-only registry token as a credential."
  }

  assert {
    condition     = contains(local.cloud_config.runcmd, ["/usr/local/libexec/ptbk-relay/install-cosign"]) && length(regexall("\\[(amd64|arm64)\\]=[0-9a-f]{64}\n", local.files["/usr/local/libexec/ptbk-relay/install-cosign"])) == 2
    error_message = "cosign is installed at first boot from a release pinned by SHA-256 for both architectures."
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

  assert {
    condition = (
      strcontains(local.files["/etc/ptbk-relay/relay.env"], "RELAY_LISTEN_BACKLOG=8192\n")
      && strcontains(local.files["/etc/sysctl.d/90-ptbk-relay.conf"], "net.core.somaxconn = 8192\nnet.ipv4.tcp_max_syn_backlog = 8192\n")
    )
    error_message = "The relay listens with the backlog the kernel allows."
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

run "installs_the_pinned_lego" {
  command = apply

  assert {
    condition     = !contains(local.cloud_config.packages, "lego")
    error_message = "Debian's lego lacks the Cloudflare DNS provider; the pinned release replaces it."
  }

  assert {
    condition = alltrue([
      for value in [
        "version=${local.lego.version}\n",
        "amd64) sha256=${local.lego.sha256_amd64} ;;",
        "arm64) sha256=${local.lego.sha256_arm64} ;;",
        "sha256sum --check",
      ] : strcontains(local.files["/usr/local/libexec/ptbk-relay/install-lego"], value)
    ])
    error_message = "The installer checks the pinned release's SHA-256 for the host's architecture."
  }

  assert {
    condition     = contains(local.cloud_config.runcmd, ["/usr/local/libexec/ptbk-relay/install-lego"])
    error_message = "cloud-init installs lego at first boot."
  }

  assert {
    condition     = strcontains(local.files["/etc/systemd/system/ptbk-relay-cert.service"], "Environment=CLOUDFLARE_DNS_API_TOKEN_FILE=%d/acme-dns-token\n")
    error_message = "lego reads the challenge zone token from the unit's credential."
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
    ssh_allowlist = ["<admin-network-cidr>"]
  }

  expect_failures = [
    var.relay_domain, var.engine_domain, var.registry_url, var.acme_email, var.admins, var.ssh_allowlist,
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

run "refuses_ssh_from_anywhere_with_an_allowlist" {
  command = plan

  variables {
    ssh_from_anywhere = true
  }

  expect_failures = [var.ssh_allowlist]
}

run "refuses_rsa_and_keys_with_options" {
  command = plan

  variables {
    admins = { ada = ["ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQ ada", "command=\"/bin/sh\" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEAvFcF9TjUmm57Av3oVnBfv6lwzliXetJmpL5iZ/p0m"] }
  }

  expect_failures = [var.admins]
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
