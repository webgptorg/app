locals {
  hostname = "${var.name}.${var.relay_domain}"

  ssh_allow_v4 = var.ssh_from_anywhere ? ["0.0.0.0/0"] : [for cidr in var.ssh_allowlist : cidr if !strcontains(cidr, ":")]
  ssh_allow_v6 = var.ssh_from_anywhere ? ["::/0"] : [for cidr in var.ssh_allowlist : cidr if strcontains(cidr, ":")]

  reboot_hour = tonumber(split(":", var.reboot_time)[0])
  renew_time  = format("%02d:%s", (local.reboot_hour + 1) % 24, split(":", var.reboot_time)[1])

  files_dir = "${path.module}/files"

  listen_backlog = 8192

  # The upstream lego release the hosts install (ADR 0011), with the SHA-256 of each architecture's tarball from the
  # release's checksums file. Bump all three together.
  lego = {
    version      = "5.5.2"
    sha256_amd64 = "2a35505089e7772c92e1e9ac144df91151ef2eca8568630db0ff91fca06d9bef"
    sha256_arm64 = "15b14ec2ab14fde69cc8396eb0204c5ce4327e31a486953225a6059b26db3e8c"
  }

  # Every file is written after the packages are installed (defer), so package defaults never overwrite them, and
  # runcmd then (re)starts each service with its final configuration.
  write_files = [
    for entry in [
      { path = "/etc/nftables.conf", permissions = "0644", content = templatefile("${local.files_dir}/nftables.conf.tftpl", {
        ssh_allow_v4 = local.ssh_allow_v4
        ssh_allow_v6 = local.ssh_allow_v6
      }) },
      { path = "/etc/sysctl.d/90-ptbk-relay.conf", permissions = "0644", content = templatefile("${local.files_dir}/sysctl.conf.tftpl", {
        listen_backlog = local.listen_backlog
      }) },
      { path = "/etc/modules-load.d/ptbk-relay.conf", permissions = "0644", content = file("${local.files_dir}/modules-load.conf") },
      { path = "/etc/systemd/journald.conf.d/ptbk-relay.conf", permissions = "0644", content = file("${local.files_dir}/journald.conf") },
      { path = "/etc/chrony/conf.d/ptbk-relay.conf", permissions = "0644", content = file("${local.files_dir}/chrony.conf") },
      { path = "/etc/unbound/unbound.conf.d/ptbk-relay.conf", permissions = "0644", content = file("${local.files_dir}/unbound.conf") },
      { path = "/etc/ptbk-relay/resolv.conf", permissions = "0644", content = file("${local.files_dir}/resolv.conf") },
      { path = "/etc/dhcp/dhclient-enter-hooks.d/ptbk-relay", permissions = "0644", content = file("${local.files_dir}/dhclient-enter-hook") },
      { path = "/etc/ssh/sshd_config.d/10-ptbk-relay.conf", permissions = "0600", content = templatefile("${local.files_dir}/sshd.conf.tftpl", {
        users = sort(keys(var.admins))
      }) },
      { path = "/etc/apt/apt.conf.d/20auto-upgrades", permissions = "0644", content = file("${local.files_dir}/auto-upgrades.conf") },
      { path = "/etc/apt/apt.conf.d/52ptbk-relay-unattended-upgrades", permissions = "0644", content = templatefile("${local.files_dir}/unattended-upgrades.conf.tftpl", {
        reboot_time = var.reboot_time
      }) },
      { path = "/etc/systemd/system/ptbk-relay.service", permissions = "0644", content = file("${local.files_dir}/ptbk-relay.service") },
      { path = "/etc/systemd/system/ptbk-relay-cert.service", permissions = "0644", content = file("${local.files_dir}/ptbk-relay-cert.service") },
      { path = "/etc/systemd/system/ptbk-relay-cert.timer", permissions = "0644", content = templatefile("${local.files_dir}/ptbk-relay-cert.timer.tftpl", {
        renew_time = local.renew_time
      }) },
      { path = "/etc/ptbk-relay/relay.env", permissions = "0644", content = templatefile("${local.files_dir}/relay.env.tftpl", {
        relay_hostname      = local.hostname
        engine_domain       = var.engine_domain
        registry_url        = var.registry_url
        max_connections     = var.max_connections
        memory_budget_bytes = var.memory_budget_mib * 1048576
        listen_backlog      = local.listen_backlog
        settings            = var.relay_settings
      }) },
      { path = "/etc/ptbk-relay/limits.env", permissions = "0644", content = templatefile("${local.files_dir}/limits.env.tftpl", {
        memory_max_mib = var.memory_max_mib
        heap_mib       = var.heap_mib
        nofile         = var.nofile
      }) },
      { path = "/etc/ptbk-relay/cert.env", permissions = "0644", content = templatefile("${local.files_dir}/cert.env.tftpl", {
        relay_hostname = local.hostname
        acme_email     = var.acme_email
        acme_server    = var.acme_server
      }) },
      { path = "/usr/local/libexec/ptbk-relay/renew-certificate", permissions = "0755", content = file("${local.files_dir}/renew-certificate") },
      { path = "/usr/local/libexec/ptbk-relay/install-certificate", permissions = "0700", content = file("${local.files_dir}/install-certificate") },
      { path = "/usr/local/libexec/ptbk-relay/install-lego", permissions = "0700", content = templatefile("${local.files_dir}/install-lego.tftpl", local.lego) },
      { path = "/usr/local/sbin/ptbk-relay-deploy", permissions = "0700", content = file("${local.files_dir}/ptbk-relay-deploy") },
      { path = "/etc/systemd/system/ptbk-relay-deploy.service", permissions = "0644", content = file("${local.files_dir}/ptbk-relay-deploy.service") },
      { path = "/etc/systemd/system/ptbk-relay-deploy.timer", permissions = "0644", content = file("${local.files_dir}/ptbk-relay-deploy.timer") },
      { path = "/etc/ptbk-relay/deploy.env", permissions = "0644", content = file("${local.files_dir}/deploy.env") },
      { path = "/usr/local/libexec/ptbk-relay/install-cosign", permissions = "0700", content = file("${local.files_dir}/install-cosign") },
    ] : merge(entry, { owner = "root:root", defer = true })
  ]

  # By path, for the tests.
  files = { for entry in local.write_files : entry.path => entry.content }

  cloud_config = {
    hostname                   = var.name
    fqdn                       = local.hostname
    prefer_fqdn_over_hostname  = false
    timezone                   = "Etc/UTC"
    ssh_pwauth                 = false
    disable_root               = true
    ssh_deletekeys             = true
    ssh_genkeytypes            = ["ed25519", "ecdsa"]
    package_update             = true
    package_upgrade            = true
    package_reboot_if_required = true
    packages = [
      "podman", "nftables", "unbound", "chrony", "unattended-upgrades", "bind9-dnsutils", "curl", "skopeo",
    ]

    users = concat(
      [for name in sort(keys(var.admins)) : {
        name                = name
        shell               = "/bin/bash"
        lock_passwd         = true
        sudo                = "ALL=(ALL) NOPASSWD:ALL"
        ssh_authorized_keys = var.admins[name]
      }],
      [
        {
          # The relay container runs as this uid (ptbk-relay.service: --user=10001:10001).
          name           = "ptbk-relay"
          uid            = 10001
          system         = true
          shell          = "/usr/sbin/nologin"
          no_create_home = true
          lock_passwd    = true
        },
      ],
    )

    write_files = local.write_files

    # lego first, while the image's own resolver is in place: in the VM test, GitHub's name did not resolve for a while
    # right after the switch to the freshly restarted unbound.
    runcmd = [
      ["/usr/local/libexec/ptbk-relay/install-lego"],
      ["install", "-d", "-m", "0700", "-o", "root", "-g", "root", "/etc/ptbk-relay/credentials"],
      ["modprobe", "nf_conntrack"],
      ["systemctl", "restart", "systemd-sysctl.service"],
      ["systemctl", "restart", "systemd-journald.service"],
      ["sh", "-c", "systemctl disable --now systemd-resolved.service 2>/dev/null || true"],
      ["sh", "-c", "rm -f /etc/resolv.conf && install -m 0644 /etc/ptbk-relay/resolv.conf /etc/resolv.conf"],
      ["systemctl", "restart", "unbound.service"],
      ["systemctl", "restart", "chrony.service"],
      ["systemctl", "enable", "nftables.service"],
      ["systemctl", "restart", "nftables.service"],
      ["systemctl", "restart", "ssh.service"],
      ["/usr/local/libexec/ptbk-relay/install-cosign"],
      ["systemctl", "daemon-reload"],
      ["systemctl", "enable", "ptbk-relay.service", "ptbk-relay-cert.timer", "ptbk-relay-deploy.timer"],
      ["systemctl", "start", "ptbk-relay-cert.timer", "ptbk-relay-deploy.timer"],
    ]
  }

  cloud_config_text = "#cloud-config\n${yamlencode(local.cloud_config)}"
}
