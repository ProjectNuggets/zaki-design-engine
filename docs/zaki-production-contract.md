# ZAKI Design production contract

This repository is the ZAKI downstream of `nexu-io/open-design`.

## Branch model

- `upstream/main`: pristine mirror of `nexu-io/open-design`.
- `main`: ZAKI-hosted adaptation.
- ZAKI changes must stay small, documented, and easy to rebase over upstream.

## Runtime boundary

ZAKI Design runs as a private engine behind `zaki-prod`. Browsers should not call
this service directly in production. `zaki-prod` owns OAuth, billing, quotas,
metering, user session state, and public product routes.

Every non-probe request in hosted mode must include:

- `X-Internal-Token: <DESIGN_ENGINE_INTERNAL_TOKEN>` or
  `Authorization: Bearer <DESIGN_ENGINE_INTERNAL_TOKEN>`
- `X-Zaki-User-Id: <central ZAKI user id>`

Open probes:

- `GET /healthz`
- `GET /livez`
- `GET /readyz`
- `GET /api/health`
- `GET /api/version`
- `GET /api/daemon/status`

## Required hosted environment

```sh
ZAKI_DESIGN_RUNTIME_MODE=hosted
DESIGN_ENGINE_INTERNAL_AUTH_REQUIRED=true
DESIGN_ENGINE_INTERNAL_TOKEN=<shared secret from zaki-infra>
ZAKI_TENANT_HEADER=X-Zaki-User-Id
OD_BIND_HOST=0.0.0.0
OD_PORT=7456
OD_DATA_DIR=/app/.od
```

`ZAKI_INTERNAL_TOKEN` and `ZAKI_DESIGN_INTERNAL_TOKEN` are accepted aliases for
the internal token so the service can share the central secret contract used by
other ZAKI engines.

## Tenant isolation

Hosted mode stamps new projects with `metadata.zakiTenantId` from the central
tenant header. Project and template listing endpoints filter records to that
tenant. Project, run, template, and project-id-bearing requests are denied when
the stored project owner does not match the tenant header.

The engine remains private infrastructure. Public access, OAuth claims, paid
plan checks, product enablement, and usage grants stay in `zaki-prod`.

## Deployment expectations

The DigitalOcean deployment is managed from `zaki-infra`, matching the learning
engine pattern:

- Image: `ghcr.io/projectnuggets/zaki-design-engine:<immutable sha tag>`
- Service port: `7456`
- Probes: `/readyz` and `/healthz`
- Persistent volume: mounted at `/app/.od`
- Secret: `zaki-design-engine-internal-token`
- No public ingress; only `zaki-prod` should reach the ClusterIP service.

## ZAKI Prod proxy contract

`zaki-prod` should call the design engine with:

```http
X-Internal-Token: <DESIGN_ENGINE_INTERNAL_TOKEN>
X-Zaki-User-Id: <authenticated ZAKI user id>
X-Zaki-Product-Id: design
```

The proxy must strip caller-supplied internal headers and derive them from the
authenticated central session.
