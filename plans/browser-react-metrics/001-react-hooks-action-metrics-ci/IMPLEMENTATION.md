# IMPLEMENTATION — browser/react hooks + action metrics + CI trusted publishing

Scope: 3 parts. Public API additions are additive (no breaking change to `withAction`/`scopeAction` signatures).

Verify gate (all must pass): `pnpm install && pnpm build && pnpm test && pnpm typecheck && pnpm lint`.

---

## Part 1 — CI trusted publishing (pnpm OIDC)

Edit `.github/workflows/publish.yml`. Goal: publish to npm via OIDC trusted publishing — **no `NODE_AUTH_TOKEN`**.

Key decisions:
- Keep `pnpm publish` (pnpm@10.30.0 supports OIDC natively).
- Drop `registry-url` from `setup-node` (avoids the empty `${NODE_AUTH_TOKEN}` `.npmrc` placeholder gotcha with pnpm). pnpm default registry is already npmjs.org.
- Provenance via `NPM_CONFIG_PROVENANCE: "true"` env on the publish step (empirically required even though docs say automatic).
- Keep `permissions: id-token: write` (already present) — required for OIDC.
- **Workflow filename MUST stay `publish.yml`** — it's referenced in the npmjs Trusted Publisher config.

Target file:
```yaml
name: Publish to npm

on:
  release:
    types: [published]
  workflow_dispatch:
    inputs:
      dry_run:
        description: "Dry run (no actual publish)"
        required: false
        default: "false"
        type: boolean

permissions:
  contents: read
  id-token: write

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm

      - run: pnpm install --frozen-lockfile

      - run: pnpm run build

      - run: pnpm run test

      - run: pnpm run typecheck

      - name: Publish (dry run)
        if: inputs.dry_run == 'true'
        run: pnpm publish --access public --no-git-checks --dry-run

      - name: Publish
        if: inputs.dry_run != 'true'
        env:
          NPM_CONFIG_PROVENANCE: "true"
        run: pnpm publish --access public --no-git-checks
```

Manual step (user, one-time — document in PR/README, NOT code): npmjs.com → package `@tigorhutasuhut/telemetry-js` → Settings → Trusted Publisher → GitHub Actions → org/user `tigorlazuardi`, repo `telemetry-js`, workflow file `publish.yml`.

---

## Part 2 — Action metrics (instrument `withAction` in `src/shared/action.ts`)

Instrument at **`withAction`** — the single execution chokepoint. `scopeAction` and the React hooks delegate to it, so they inherit metrics. Do NOT instrument `scopeAction` (misses one-off `withAction` calls) or `withTrace` (too generic — over-emits on every span).

Public signatures of `withAction` / `scopeAction` / `ScopedAction` MUST NOT change.

### Instruments (module-level lazy singletons)

Meter name: `"@tigorhutasuhut/telemetry-js/ui-action"`.

```ts
import { metrics, type Histogram, type UpDownCounter } from "@opentelemetry/api";

let _hist: Histogram | undefined;
let _active: UpDownCounter | undefined;

function durationHistogram(): Histogram {
  if (!_hist) {
    _hist = metrics
      .getMeter("@tigorhutasuhut/telemetry-js/ui-action")
      .createHistogram("ui.action.duration", {
        unit: "s", // EXPLICIT seconds — required
        description: "Duration of a UI action (success or failure), in seconds.",
        advice: {
          // 5ms … 10s, expressed in seconds (unit "s")
          explicitBucketBoundaries: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
        },
      });
  }
  return _hist;
}

function activeCounter(): UpDownCounter {
  if (!_active) {
    _active = metrics
      .getMeter("@tigorhutasuhut/telemetry-js/ui-action")
      .createUpDownCounter("ui.action.active", {
        unit: "{action}", // EXPLICIT UCUM annotation — dimensionless count
        description: "Number of UI actions currently in flight.",
      });
  }
  return _active;
}

/** Internal: reset cached instruments (tests). @internal */
export function _resetActionMetrics(): void {
  _hist = undefined;
  _active = undefined;
}
```

Notes:
- `metrics.getMeter()` returns a noop meter when no `MeterProvider` is registered → `record`/`add` are no-ops. Always-on is safe + ~zero cost when metrics endpoint not configured.
- Caching the instrument is fine even if the global MeterProvider is set AFTER first use: OTel's noop-then-real meter proxy resolves through the global provider. If tests need a fresh instrument, call `_resetActionMetrics()`.

### Metric attributes (LOW cardinality only)

- duration: `ui.action`, `ui.component` (if present), `ui.page` (if present), `error.type` (only on failure).
- active: same base attrs **without** `error.type`.
- Do NOT fold the per-call `attributes` map into metrics (free-form → cardinality risk). It stays on the span only.

`error.type` value: `err instanceof Error ? (err.name || err.constructor?.name || "Error") : "Error"`.

### Wiring inside `withAction`

Wrap around the existing `withTrace(...)` call. Handle sync return, promise, and sync throw. Use `performance.now()` (monotonic; available in all target runtimes). Record duration in **seconds** = `(performance.now() - start) / 1000`.

```ts
export function withAction<T>(action: string, fn: (span: Span) => T, opts?: ActionOptions): T {
  const baseAttrs: Record<string, string> = { "ui.action": action };
  if (opts?.component) baseAttrs["ui.component"] = opts.component;
  if (opts?.page) baseAttrs["ui.page"] = opts.page;

  const hist = durationHistogram();
  const active = activeCounter();
  const start = performance.now();

  const record = (errorType?: string) => {
    const attrs = errorType ? { ...baseAttrs, "error.type": errorType } : baseAttrs;
    hist.record((performance.now() - start) / 1000, attrs);
  };
  const errType = (e: unknown) =>
    e instanceof Error ? e.name || e.constructor?.name || "Error" : "Error";

  active.add(1, baseAttrs);

  try {
    const result = withTrace(fn, {
      name: action,
      component: opts?.component,
      attributes: buildAttributes(action, opts),
    });

    if (result != null && typeof (result as PromiseLike<unknown>).then === "function") {
      return (result as unknown as PromiseLike<unknown>).then(
        (value) => {
          active.add(-1, baseAttrs);
          record();
          return value;
        },
        (error: unknown) => {
          active.add(-1, baseAttrs);
          record(errType(error));
          throw error;
        },
      ) as T;
    }

    active.add(-1, baseAttrs);
    record();
    return result;
  } catch (error) {
    active.add(-1, baseAttrs);
    record(errType(error));
    throw error;
  }
}
```

Keep existing JSDoc; add a short note that metrics `ui.action.duration` + `ui.action.active` are emitted.

### Tests — `test/action-metrics.test.ts` (TDD: write first)

Set up a real in-memory metrics pipeline (repo already deps `@opentelemetry/sdk-metrics`):
- `MeterProvider` with an in-memory reader (e.g. `InMemoryMetricExporter` + `PeriodicExportingMetricReader`, or a manual reader); register via `metrics.setGlobalMeterProvider(...)`. Call `_resetActionMetrics()` in `beforeEach` so instruments bind to the test provider.
- Cases:
  1. success sync fn → 1 histogram data point, attrs `ui.action`/`ui.component`/`ui.page`, NO `error.type`; unit metadata is `"s"`.
  2. success async fn → recorded after promise resolves; value > 0.
  3. throwing fn (sync + async) → data point has `error.type` = error class name; error re-thrown.
  4. `ui.action.active` returns to 0 after settle (sum of +1/-1).
  5. no MeterProvider → no throw (noop).
- Reset global meter provider between tests as needed.

---

## Part 3 — `/browser/react` hooks (`src/browser/react/index.ts`)

New file. Runtime-light: imports only `react` (`useMemo`) + `import type` from OTel/shared (type-only, erased). The `scopeAction`/`withAction` impl loads lazily via dynamic `import("../../shared/action.js")` — mirror the lazy idiom in `src/browser/fetch/patch.ts`.

```ts
import { useMemo } from "react";
import type { Span } from "@opentelemetry/api";
import type { ActionOptions, ActionScope, ScopedAction } from "../../shared/action.js";

export type { ActionOptions, ActionScope, ScopedAction };

/** Async scoped action — resolves once the lazily-loaded action module is ready. */
export type AsyncScopedAction = <T>(
  action: string,
  fn: (span: Span) => T,
  attributes?: Record<string, string>,
) => Promise<Awaited<T>>;

/** Async one-off action runner. */
export type AsyncAction = <T>(
  action: string,
  fn: (span: Span) => T,
  opts?: ActionOptions,
) => Promise<Awaited<T>>;

type ActionMod = typeof import("../../shared/action.js");

let _mod: ActionMod | null = null;
let _modPromise: Promise<ActionMod> | null = null;

/** Kick off (or return) the lazy load of the action module. Idempotent. */
function ensureActionModule(): Promise<ActionMod> {
  if (_mod) return Promise.resolve(_mod);
  if (!_modPromise) {
    _modPromise = import("../../shared/action.js").then((m) => {
      _mod = m;
      return m;
    });
  }
  return _modPromise;
}

/** Reset lazy-load state (tests). @internal */
export function _resetReactActionModule(): void {
  _mod = null;
  _modPromise = null;
}

/** Internal factory — testable without a React renderer. @internal */
export function createScopedAction(scope: ActionScope): AsyncScopedAction {
  return async (action, fn, attributes) => {
    const mod = _mod ?? (await ensureActionModule());
    return mod.scopeAction(scope)(action, fn, attributes) as Awaited<ReturnType<typeof fn>>;
  };
}

/** Internal factory — testable without a React renderer. @internal */
export function createOneOffAction(): AsyncAction {
  return async (action, fn, opts) => {
    const mod = _mod ?? (await ensureActionModule());
    return mod.withAction(action, fn, opts);
  };
}

/**
 * React hook: a scoped UI-action runner that lazily loads the tracing/metrics
 * code (non-blocking during render). The returned callback awaits that lazy
 * load on first use, so an action triggered before the module is ready simply
 * resolves once it arrives.
 */
export function useScopeAction(scope: ActionScope): AsyncScopedAction {
  // Kick the lazy load during render — non-blocking, idempotent.
  ensureActionModule();
  const { page, component } = scope;
  return useMemo(() => createScopedAction({ page, component }), [page, component]);
}

/** React hook: a one-off UI-action runner (lazy, like {@link useScopeAction}). */
export function useAction(): AsyncAction {
  ensureActionModule();
  return useMemo(() => createOneOffAction(), []);
}
```

Resolve generic return typing so `tsc --strict` passes; cast narrowly if needed (the inner `ScopedAction` is generic). Keep file biome-clean (tabs, double quotes).

### Tests — `test/react-action.test.ts` (TDD: write first)

Test the factories (no React render needed):
- `beforeEach` → `_resetReactActionModule()`.
- cold first call resolves to fn's return value (proves blocking-until-loaded: the call awaits the dynamic import).
- returns a Promise always.
- error from fn propagates (rejects).
- `createOneOffAction()` runs `withAction` with passed opts.
- (optional) verify `ensureActionModule()` dedupes — two calls share one promise.

---

## Part 4 — Wiring: `package.json` + `typedoc.json`

`package.json`:
- Add export entry (place alphabetically-ish near other browser entries):
  ```json
  "./browser/react": {
    "types": "./dist/browser/react/index.d.ts",
    "default": "./dist/browser/react/index.js"
  }
  ```
- `peerDependencies`: add `"react": ">=18"`.
- `peerDependenciesMeta`: add `"react": { "optional": true }`.
- `devDependencies`: add `"react"` and `"@types/react"` (so local build/typecheck/tests resolve them). Use current stable versions.
- Run `pnpm install` to update `pnpm-lock.yaml`.

`typedoc.json`: add `"./src/browser/react/index.ts"` to `entryPoints`.

No `tsconfig.json` change expected (lib already has DOM; `react` imported explicitly so the narrowed `types` array is fine). Confirm build emits `dist/browser/react/index.{js,d.ts}`.

---

## Part 5 — Docs (`README.md`)

Add two short sections:
1. **React hooks** (`/browser/react`): `useScopeAction` / `useAction` usage, the lazy/non-blocking behavior, that it keeps the React entry light (OTel loads on demand).
2. **UI action metrics**: `ui.action.duration` (Histogram, **unit `s`**) + `ui.action.active` (UpDownCounter), the recommended low-cardinality attributes (`ui.action`, `ui.component`, `ui.page` as route template, `error.type`), and the cardinality warning. Note metrics are emitted automatically by `withAction`/`scopeAction`/hooks and require a metrics endpoint (see Part 3 / browser metrics) to be exported.
