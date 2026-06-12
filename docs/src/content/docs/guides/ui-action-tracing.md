---
title: UI Action Tracing
description: Wrap user interactions in OpenTelemetry spans using withAction, scopeAction, and the React hooks useScopeAction / useAction.
---

UI action tracing wraps user interactions — button clicks, form submits, toggles — in OpenTelemetry spans that carry page and component context. Each action also emits duration and in-flight metrics automatically.

`withAction` and `scopeAction` are re-exported from every server-side subpath (`/node`, `/bun`, `/cloudflare`) and from the browser lazy facade (`/browser`). React hooks live in `/browser/react`.

## `withAction` — one-off actions

```ts
withAction(action, fn, opts?)
```

Runs `fn` inside a span named `action` (or `Component.action` when `opts.component` is set). Returns whatever `fn` returns — the wrapper is transparent to the caller.

```ts
import { withAction } from "@tigorhutasuhut/telemetry-js/node";

await withAction(
  "submit",
  () => authClient.signIn.email({ email, password }),
  { page: "/auth/sign-in", component: "SignInForm" },
);
```

The span carries these attributes:

| Attribute | Value |
| --- | --- |
| `ui.action` | The `action` argument |
| `ui.page` | `opts.page` (when set) |
| `ui.component` | `opts.component` (when set) |

Extra per-call attributes can be attached via `opts.attributes`. They land on the span only — see [Cardinality](#cardinality) below.

**Browser passthrough:** before `initSDK()` completes, `withAction` in the `/browser` facade runs `fn` synchronously with no span and returns its value. The wrapper signature stays `T`, not `Promise<T>`.

## `scopeAction` — scoped reuse

```ts
scopeAction(scope) → ScopedAction
```

Creates a reusable action runner that pre-fills `page` and `component` on every call. Define it once at the component level and call it for each interaction — no need to repeat the scope each time.

```ts
import { scopeAction } from "@tigorhutasuhut/telemetry-js/node";

const action = scopeAction({ page: "/auth/sign-in", component: "SignInForm" });

// Each call creates a span — "SignInForm.submit", "SignInForm.reset", etc.
await action("submit", () => authClient.signIn.email({ email, password }));
await action("reset", () => resetForm());

// Per-call extra attributes (span only, not metrics)
await action("submit", () => signIn(), { "auth.method": "email" });
```

The third argument to a `ScopedAction` call is an optional `attributes` record. These are free-form span attributes and are intentionally excluded from the emitted metrics.

## Options

### `ActionScope`

Passed to `scopeAction`. Both fields are optional.

| Option | Type | Description |
| --- | --- | --- |
| `page` | `string` | Page route or path (e.g. `"/auth/sign-in"`) |
| `component` | `string` | Component name (e.g. `"SignInForm"`) |

### `ActionOptions`

Passed as `opts` to `withAction`. Extends `ActionScope`.

| Option | Type | Description |
| --- | --- | --- |
| `page` | `string` | Page route or path |
| `component` | `string` | Component name |
| `attributes` | `Record<string, string>` | Extra span attributes (span only, not metrics) |

## React hooks

```ts
import { useScopeAction, useAction } from "@tigorhutasuhut/telemetry-js/browser/react";
```

Both hooks lazy-load the OTel tracing and metrics code on first use — the `/browser/react` entry stays bundle-minimal until an action actually fires.

**Both hooks return async functions** (`AsyncScopedAction` / `AsyncAction`). Always `await` them.

### `useScopeAction`

Takes an `ActionScope` **object** and returns a stable scoped runner (memoized on `page` + `component`). The lazy load is kicked off during render — non-blocking — so the module is usually ready by the time the user interacts.

```tsx
import { useScopeAction } from "@tigorhutasuhut/telemetry-js/browser/react";

function SignInForm() {
  const action = useScopeAction({ page: "/auth/sign-in", component: "SignInForm" });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await action("submit", () => authClient.signIn.email({ email, password }));
  };

  const handleReset = async () => {
    await action("reset", () => resetForm());
  };

  return (
    <form onSubmit={handleSubmit}>
      {/* ... */}
      <button type="button" onClick={handleReset}>Reset</button>
      <button type="submit">Sign in</button>
    </form>
  );
}
```

### `useAction`

Returns a one-off runner with no pre-filled scope. Pass `opts` per call.

```tsx
import { useAction } from "@tigorhutasuhut/telemetry-js/browser/react";

function DeleteButton({ userId }: { userId: string }) {
  const action = useAction();

  const handleClick = async () => {
    await action(
      "delete-user",
      () => api.users.delete(userId),
      { page: "/admin/users", component: "DeleteButton" },
    );
  };

  return <button onClick={handleClick}>Delete</button>;
}
```

## Metrics

`withAction`, `scopeAction`, and both React hooks automatically emit `ui.action.duration` (Histogram, seconds) and `ui.action.active` (UpDownCounter) via the global `MeterProvider`. No extra wiring needed.

For the full metric definitions, attribute tables, and dashboard setup see [UI Action Metrics](/guides/ui-action-metrics).

## Cardinality

Use route **templates** for `ui.page`, never raw paths with user data:

```ts
// Good
{ page: "/users/:id" }

// Bad — one metric series per user
{ page: `/users/${userId}` }
```

Per-call `attributes` (the third arg to a `ScopedAction`, or `opts.attributes` on `withAction`) are attached to the **span only**. They are excluded from metrics to keep cardinality bounded. See [UI Action Metrics — Cardinality warning](/guides/ui-action-metrics#metric-attributes) for details.
