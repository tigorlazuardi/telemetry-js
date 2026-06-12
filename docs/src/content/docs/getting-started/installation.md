---
title: Installation
description: Install @tigorhutasuhut/telemetry-js
sidebar:
  order: 1
---

## Install the package

```bash
pnpm add @tigorhutasuhut/telemetry-js
```

npm, yarn, and bun equivalents:

```bash
npm install @tigorhutasuhut/telemetry-js
yarn add @tigorhutasuhut/telemetry-js
bun add @tigorhutasuhut/telemetry-js
```

## Optional peer dependencies

### Node.js (and Bun)

Install [pino](https://github.com/pinojs/pino) for structured JSON logging to stderr:

```bash
pnpm add pino
```

Pino is an optional peer dependency. The SDK falls back to a built-in formatter if pino is not installed.

### Browser / React

Install `react` (>=18) to use the React hooks (`useScopeAction`, `useAction`):

```bash
pnpm add react
```

React is an optional peer dependency — not installed automatically.

## Never throws

The SDK **never throws**. On any failure it returns a structured noop result so your application keeps running. You do not need to wrap `initSDK` calls in try/catch.

## Next steps

Choose the guide for your runtime:

- [Node.js / Bun](/runtimes/node)
- [Cloudflare Workers](/runtimes/cloudflare)
- [Browser](/runtimes/browser)
