---
title: UI Action Metrics
description: Automatic OTel metrics emitted by withAction, scopeAction, and the React hooks for tracking UI action duration and in-flight counts.
---

`withAction`, `scopeAction`, and the React hooks (`useScopeAction` / `useAction`) automatically emit two OTel metrics. No extra setup is needed beyond a configured metrics endpoint (see [Quick Start — Browser](/runtimes/browser) and `metricsExporterEndpoint` in [Configuration Options](/guides/configuration)).

When no `MeterProvider` / metrics endpoint is configured the metrics go to a noop meter — zero effect, always safe to leave in.

## Emitted metrics

| Metric | Instrument | Unit | Description |
| --- | --- | --- | --- |
| `ui.action.duration` | Histogram | `s` | Time from action start to settle. Derive request rate (count), latency percentiles, and error rate from this single instrument. |
| `ui.action.active` | UpDownCounter | `{action}` | In-flight actions gauge. Useful to spot stuck or overlapping actions. |

`ui.action.duration` uses explicit bucket boundaries (in seconds): `0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10`.

## Metric attributes

All attributes are **low cardinality**:

| Attribute | Set when | Notes |
| --- | --- | --- |
| `ui.action` | Always | The action name passed to `withAction` / `scopeAction` / the hook |
| `ui.component` | When component scope is set | E.g. the `scope` arg to `useScopeAction` |
| `ui.page` | When page scope is set | See cardinality warning below |
| `error.type` | On failure only | Error class name (e.g. `TypeError`) |

> **Cardinality warning:** use a route **template** for `ui.page` (e.g. `/users/:id`), never raw paths with user IDs or other high-cardinality values. Per-call free-form `attributes` passed to an action are recorded on the **span only** — they are intentionally excluded from metrics to keep metric cardinality bounded.
