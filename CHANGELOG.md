# Changelog

## [1.1.0] - 2026-10-11

- Shield: a live view of who is knocking on Traefik. Every source comes in from its own direction; what Traefik stops at the edge (rate limits, allow lists, the CrowdSec plugin, auth, unknown hosts) breaks on the shield, what gets through reaches the core.
- Attacks are detected against the usual traffic, followed live and kept afterwards with their sources, targets, countries and timeline. The webhook hears when one starts and ends.
- Loudest sources over 5 or 15 minutes, with what they asked for, their user agent and a ready command to ban them.
- CrowdSec: active bans, why and until when, read with a bouncer key that can only read decisions. The installer offers to set this up when it finds CrowdSec.
- A health check for Traefik seeing Cloudflare's addresses instead of the visitors'.
- The country of each request when Traefik keeps Cloudflare's Cf-Ipcountry header.
- `npm run attack` sends a fake attack at the lab.

## [1.0.0] - 2026-10-11

First release.

- Overview with a health score, live traffic, the busiest routers and what needs a look.
- Routers, services, middlewares and entry points for HTTP, TCP and UDP, with search, filters and details.
- Topology map from entry points through routers and middlewares to services and servers.
- Live traffic from Traefik's Prometheus metrics: requests, status classes, latency percentiles, bandwidth.
- Access log explorer with filters, live tail and statistics.
- Certificates with expiry warnings.
- Health checks that explain what is wrong in Traefik's configuration and how to fix it.
- Change history with before and after for every router, service and middleware.
- Rule tester: which router takes a given request.
- Raw API explorer and the static configuration Traefik reports.
- Password login, or trust a forward-auth header; webhook alerts for new critical findings.
- Update notice for new Enodia and Traefik releases.
- Installer for Traefik in Docker, Swarm, on the host, or no Traefik at all; Node.js and systemd without Docker.
- Works with Traefik v2.11 and v3.
