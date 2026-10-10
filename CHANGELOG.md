# Changelog

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
