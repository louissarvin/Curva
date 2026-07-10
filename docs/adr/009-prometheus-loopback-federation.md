# ADR 009: Prometheus Federation on Loopback via Shared prom-client Registry

## Context

Curva runs observability inside the Bare worker across five stat sources:

1. `hypertrace-prometheus`: Curva-emitted trace counters per tracer object
2. `hypercore-stats`: replicator rx/tx, cache hit rates, core open counts
3. `hyperswarm-stats`: connect attempts, dedup counts (registers HyperDhtStats
   internally)
4. `hyperdht-stats`: DHT punches, udx_* transport gauges
5. `backend/src/lib/observability.ts`: HTTP federation from the Curva Companion

Each package documents itself as installing gauges via
`registerPrometheusMetrics(promClient)`. Two independent risks show up when you
compose them:

1. **Split registries.** `hypertrace-prometheus@1.0.0` is a factory
   (`(opts) => traceFunction`, not a constructor: see
   `pear-app/node_modules/hypertrace-prometheus/index.js:6`) and by default
   creates its own `Registry`. If it uses a private registry while the stats
   packages install on `promClient.register` (the default), `/metrics` returns
   only one of them.
2. **Double registration.** `hyperswarm-stats` internally instantiates a
   `HyperDhtStats` and calls its `registerPrometheusMetrics`. If a caller also
   registers `hyperdht-stats` explicitly against the same DHT, `prom-client`
   throws on the duplicate gauge name.

Audit finding C1 additionally required binding the exporter to loopback so LAN
peers cannot scrape the process from a foreign address.

Docs consulted:
- https://github.com/holepunchto/hypertrace (fetched 2026-07-10)
- https://github.com/holepunchto/hypertrace-prometheus (fetched 2026-07-10)
- https://github.com/holepunchto/hypercore-stats (fetched 2026-07-10)
- https://github.com/holepunchto/hyperswarm-stats (fetched 2026-07-10)
- https://github.com/holepunchto/hyperdht-stats (fetched 2026-07-10)
- https://docs.pears.com/reference/building-blocks/ (observability section, fetched 2026-07-10)

## Decision

1. **Bind to 127.0.0.1 explicitly.** The hypertrace-prometheus factory at
   ^1.0.0 binds `0.0.0.0` internally, which is unacceptable. Curva shims by
   passing `skipListen: true` (where supported) and standing up its own
   `http.createServer(...).listen(port, '127.0.0.1', ...)`
   (`bare/observability.js:259-383`). The URL logged at boot is
   `http://127.0.0.1:<port>/metrics` (default 4343).
2. **Share the prom-client default registry.** We pass
   `register: promClient.register` to the hypertrace-prometheus factory so
   `trace_counter` lands on the same registry as the `hypercore_*`,
   `hyperswarm_*`, `dht_*`, and `udx_*` gauges. One `/metrics` response
   federates them all (`bare/observability.js:11-15`).
3. **Idempotent installer.** `startPrometheus()` is idempotent: a second call
   with the same options resolves to the same handle
   (`bare/observability.js:74`). This guards against a caller that boots
   observability twice during hot reload.
4. **Guard against hyperswarm-stats' internal DHT registration.** Before
   installing `hyperdht-stats` we check if the swarm-registered DHT gauges are
   already present on the shared registry and skip the second install
   (`bare/observability.js:58-63`).
5. **No PII in labels.** The `allowedProps` whitelist for hypertrace is
   `['name']` only (`bare/observability.js:76-77`). Trace IDs are short opaque
   strings (`'registered'`, `'apply'`, `'send'`), never user handles.
6. **Backend federation.** `backend/src/lib/observability.ts` exposes
   `/metrics` deduped to a single route registration (Wave 3 route fix
   removed a duplicate). The Pear worker can scrape it optionally per
   feature flag.

## Consequences

Positive:
- One `/metrics` endpoint federates every stats family. Grafana can scrape a
  single URL and get the full picture.
- Loopback bind closes the C1 audit finding without breaking local dev
  workflows (curl still works from the same host).
- Idempotency lets hot reload keep the previously installed gauges without
  churn or prom-client throw.

Negative:
- The self-hosted HTTP server duplicates work hypertrace-prometheus would
  otherwise do. When upstream v1.1+ adds a `host` option we can drop the shim.
- Any prom-client dependency drift across the stats packages could still
  produce a duplicate-gauge throw; we mitigate with the guard at
  `bare/observability.js:58-63` but the fix is layered, not root-cause.

Alternatives rejected:
- **Two exporters (one per registry).** Rejected because operators would have
  to scrape two URLs and merge, and Grafana federation across two ports on
  the same host is fragile.
- **Skip hypertrace-prometheus and roll our own.** Rejected because the
  package's factory is already the documented path in the Pears observability
  docs; rolling our own would drift from that.
- **Bind 0.0.0.0 with a firewall rule.** Rejected because the firewall is not
  the app's contract; the app must be safe by default.

## References

- https://github.com/holepunchto/hypertrace-prometheus (fetched 2026-07-10)
- https://github.com/holepunchto/hyperswarm-stats (fetched 2026-07-10)
- `pear-app/node_modules/hypertrace/index.js:107-121`
- `pear-app/node_modules/hypertrace-prometheus/index.js:6`
- `pear-app/node_modules/hypercore-stats/index.js:492-507`
- `pear-app/node_modules/hyperswarm-stats/index.js:1-289`
- `pear-app/bare/observability.js:11-15` (shared registry pass-through)
- `pear-app/bare/observability.js:259-383` (loopback bind + skipListen shim)
- `pear-app/bare/observability.js:58-63` (double-registration guard)
- `backend/src/lib/observability.ts` (backend federation route)
