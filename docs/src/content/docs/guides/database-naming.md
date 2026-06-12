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
