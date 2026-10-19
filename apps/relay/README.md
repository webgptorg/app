# @ptbk/relay

SNI passthrough relay. Engines dial in over `wss://relay-<region>.<domain>/v1/tunnel` and keep a multiplexed tunnel open; browsers connect on 443 and the relay pipes their TLS bytes into the matching tunnel without decrypting them (spec, Relay and tunnel; Interfaces 3).

Runs on Node 24 on plain VPSs, several in parallel. Must never hold an engine key or terminate TLS for an engine hostname. Not scaffolded yet.
