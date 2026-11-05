---
title: Database Query Naming
description: Name database queries via OTel context using withQueryName and getQueryName from the /db subpath.
---

The `/db` subpath provides `withQueryName` / `getQueryName` for naming database queries via the OTel context. `withQueryName` creates a `CLIENT` span and stores the name so your DB driver wrapper can read it.

```ts
import { withQueryName, getQueryName } from "@tigorhutasuhut/telemetry-js/db";

// Application code — name the query
const user = await withQueryName("getUser", () =>
  db.query("SELECT * FROM users WHERE id = $1", [id]),
);
```

Inside your DB driver wrapper, read the name:

```ts
import { getQueryName } from "@tigorhutasuhut/telemetry-js/db";

function query(sql: string, params: unknown[]) {
  const name = getQueryName(); // "getUser" (or undefined if not set)
  // Use name for logging, pg prepared statements, etc.
  return pool.query({ text: sql, values: params, name });
}
```

`withQueryName` creates a span named `db.{name}` with `db.query.name` attribute. It composes with `withTrace` and the context module — the query name propagates through nested OTel contexts:

```ts
await withTrace(async function handleRequest(span) {
  // Query name is available inside the traced scope
  const user = await withQueryName("getUser", () => db.findUser(id));
  const orders = await withQueryName("listOrders", () => db.findOrders(user.id));
  return { user, orders };
});
```

## Keeping query parameters out of failed spans

When a query fails, `withQueryName` puts the error on its span: the message becomes the span status and `recordException` adds an event with the message and stack trace. Some drivers put the bound parameters in that message. Drizzle's is `Failed query: <sql>\nparams: <values>`, so a failed `UPDATE` exports the values you tried to write.

Turn on `redactParams` once at startup to stop that:

```ts
import { configureDb } from "@tigorhutasuhut/telemetry-js/db";

configureDb({ redactParams: true });
```

With it on, everything from the `params:` line onward is dropped from the span status, the exception message and the stack trace header, on the spans `withQueryName` **and `withTrace`** create. A failed query passes up through the `withTrace` spans around it, so both layers are covered. The SQL text, the error name and the stack frames stay, and the error you re-throw is unchanged.

- **Default is `false`**, so existing behaviour does not change.
- **Process-wide.** `configureDb` replaces the previous options; call it with no argument to turn it off again.
- **Only these two span creators.** `traceHandler`, the Cloudflare bindings and workflows, the fetch instrumentation, and logger or `console` output still record the raw error message.
- **Matches the `\nparams:` convention** only. A driver that puts values elsewhere in the message is not covered.
