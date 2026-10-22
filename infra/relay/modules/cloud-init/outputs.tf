output "hostname" {
  description = "The relay's own hostname (RELAY_HOSTNAME)."
  value       = local.hostname
}

output "user_data" {
  description = "cloud-init user data for the host. Holds no secret: those are placed on the host by hand (README)."
  value       = "#cloud-config\n${yamlencode(local.cloud_config)}"

  # A relay hostname under the engine domain would make the relay a TLS endpoint for an engine name (AGENTS.md
  # rule 1); the relay refuses to start with one, so this fails the plan instead.
  precondition {
    condition     = !(local.hostname == var.engine_domain || endswith(local.hostname, ".${var.engine_domain}"))
    error_message = "The relay hostname ${local.hostname} must not be under the engine domain ${var.engine_domain}."
  }

  precondition {
    condition     = var.nofile >= 4 * var.max_connections
    error_message = "nofile must be at least four times max_connections."
  }

  precondition {
    condition     = var.heap_mib + var.memory_budget_mib + 512 <= var.memory_max_mib
    error_message = "heap_mib plus memory_budget_mib plus 512 MiB of headroom for socket buffers and Node itself must fit in memory_max_mib."
  }
}
