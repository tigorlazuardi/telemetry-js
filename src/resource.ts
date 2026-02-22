import {
  defaultResource,
  detectResources,
  resourceFromAttributes,
  type Resource,
  type ResourceDetector,
} from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import type { SDKConfig } from "./types.js";

const ATTR_DEPLOYMENT_ENVIRONMENT_NAME = "deployment.environment.name";
const ATTR_SERVICE_NAMESPACE = "service.namespace";

/**
 * Parse `OTEL_RESOURCE_ATTRIBUTES` and `OTEL_SERVICE_NAME` from a flat env map.
 *
 * Only needed for runtimes where `process.env` is unavailable (e.g. Cloudflare Workers).
 * For Node the built-in `envDetector` already handles this.
 */
export function parseEnvResourceAttributes(
  env: Record<string, string | undefined>,
): Record<string, string> {
  const attrs: Record<string, string> = {};

  const raw = env.OTEL_RESOURCE_ATTRIBUTES;
  if (raw) {
    for (const pair of raw.split(",")) {
      const idx = pair.indexOf("=");
      if (idx <= 0) continue;
      const key = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      if (key) attrs[key] = decodeURIComponent(value);
    }
  }

  // OTEL_SERVICE_NAME takes precedence over service.name in OTEL_RESOURCE_ATTRIBUTES
  const serviceName = env.OTEL_SERVICE_NAME?.trim();
  if (serviceName) {
    attrs[ATTR_SERVICE_NAME] = serviceName;
  }

  return attrs;
}

/** Returns `true` when stderr is a TTY (Node only). */
function isStderrTTY(): boolean {
  try {
    return typeof process !== "undefined" && !!process.stderr?.isTTY;
  } catch {
    return false;
  }
}

export interface BuildResourceResult {
  resource: Resource;
  warnings: string[];
}

/**
 * Build a merged {@link Resource} from config, runtime detectors, and env overrides.
 *
 * Merge order (later wins):
 * 1. OTel default resource (SDK info + `unknown_service:node`)
 * 2. Config-provided attributes (`config.serviceName`, `config.resourceAttributes`)
 * 3. Runtime detectors (e.g. `envDetector`, `hostDetector` on Node — handles `process.env` automatically)
 * 4. `config.env` overrides (manual parse for Cloudflare Workers where `process.env` is absent)
 *
 * After merging, validates `service.name`, `deployment.environment.name`, and `service.namespace`
 * and emits actionable warnings for any that are missing.
 * When stderr is a TTY, auto-sets `deployment.environment.name` and `service.namespace` to `"local"`.
 */
export function buildResource(
  config: SDKConfig,
  runtimeDetectors: ResourceDetector[],
): BuildResourceResult {
  const warnings: string[] = [];

  // 1. OTel default resource
  const base = defaultResource();

  // 2. Config-provided resource
  const configAttrs: Record<string, string> = { ...config.resourceAttributes };
  if (config.serviceName != null) {
    configAttrs[ATTR_SERVICE_NAME] = config.serviceName;
  }
  const configResource = resourceFromAttributes(configAttrs);

  // 3. Runtime detectors (Node: envDetector parses process.env automatically; CF: [])
  const detected = detectResources({ detectors: runtimeDetectors });

  // 4. config.env overrides (Cloudflare Workers)
  let envOverride: Resource | null = null;
  if (config.env) {
    const envAttrs = parseEnvResourceAttributes(config.env);
    if (Object.keys(envAttrs).length > 0) {
      envOverride = resourceFromAttributes(envAttrs);
    }
  }

  // Merge: later takes precedence
  let resource = base.merge(configResource).merge(detected);
  if (envOverride) {
    resource = resource.merge(envOverride);
  }

  // --- Validation ---
  const serviceName = resource.attributes[ATTR_SERVICE_NAME] as string | undefined;
  const deployEnv = resource.attributes[ATTR_DEPLOYMENT_ENVIRONMENT_NAME] as string | undefined;
  const serviceNs = resource.attributes[ATTR_SERVICE_NAMESPACE] as string | undefined;

  const tty = isStderrTTY();

  // TTY fallback for deployment.environment.name and service.namespace
  const ttyAttrs: Record<string, string> = {};
  if (!deployEnv && tty) {
    ttyAttrs[ATTR_DEPLOYMENT_ENVIRONMENT_NAME] = "local";
  }
  if (!serviceNs && tty) {
    ttyAttrs[ATTR_SERVICE_NAMESPACE] = "local";
  }
  if (Object.keys(ttyAttrs).length > 0) {
    resource = resource.merge(resourceFromAttributes(ttyAttrs));
  }

  // Warnings
  if (!serviceName || /^unknown_service/.test(serviceName)) {
    const resolved = serviceName ?? "unknown";
    warnings.push(
      `service.name resolved to "${resolved}". Traces and logs will not be attributable to a specific service. To fix, set OTEL_SERVICE_NAME or pass serviceName in config. Example: OTEL_SERVICE_NAME=my-api`,
    );
  }

  if (!resource.attributes[ATTR_DEPLOYMENT_ENVIRONMENT_NAME]) {
    warnings.push(
      "deployment.environment.name is not set. Logs and traces cannot be filtered by deployment environment. Set OTEL_RESOURCE_ATTRIBUTES to include it. Example: OTEL_RESOURCE_ATTRIBUTES=deployment.environment.name=production,service.namespace=my-team",
    );
  }

  if (!resource.attributes[ATTR_SERVICE_NAMESPACE]) {
    warnings.push(
      "service.namespace is not set. Logs and traces cannot be filtered by namespace. Set OTEL_RESOURCE_ATTRIBUTES to include it. Example: OTEL_RESOURCE_ATTRIBUTES=service.namespace=my-team,deployment.environment.name=production",
    );
  }

  return { resource, warnings };
}
