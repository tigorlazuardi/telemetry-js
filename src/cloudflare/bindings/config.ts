/**
 * Binding instrumentation configuration store.
 *
 * Wired into `ensureSDK` so that user config reaches all binding wrappers
 * without passing it explicitly on every call site.
 */

/** Default histogram bucket boundaries (ms) tuned for Cloudflare edge-storage. */
export const DEFAULT_BOUNDARIES: number[] = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000];

/** Resolved binding config (all fields required, defaults applied). */
export interface BindingConfig {
	captureKeys: boolean;
	boundaries: number[];
	orphan: "skip" | "root";
}

let _config: BindingConfig = {
	captureKeys: false,
	boundaries: DEFAULT_BOUNDARIES,
	orphan: "skip",
};

/**
 * Merge user-supplied binding config into the module-level store.
 * Fields that are `undefined` in `c` leave the existing value unchanged.
 *
 * @param c - Partial config sourced from {@link SDKConfig}.
 */
export function setBindingConfig(c: {
	bindingCaptureKeys?: boolean;
	bindingHistogramBoundaries?: number[];
	orphanBindingSpans?: "skip" | "root";
}): void {
	if (c.bindingCaptureKeys !== undefined) {
		_config = { ..._config, captureKeys: c.bindingCaptureKeys };
	}
	if (c.bindingHistogramBoundaries !== undefined) {
		_config = { ..._config, boundaries: c.bindingHistogramBoundaries };
	}
	if (c.orphanBindingSpans !== undefined) {
		_config = { ..._config, orphan: c.orphanBindingSpans };
	}
}

/**
 * Return the current resolved binding config.
 *
 * @returns A snapshot of the current {@link BindingConfig}.
 */
export function getBindingConfig(): BindingConfig {
	return _config;
}

/**
 * Reset binding config to defaults (for testing).
 * @internal
 */
export function _resetBindingConfig(): void {
	_config = {
		captureKeys: false,
		boundaries: DEFAULT_BOUNDARIES,
		orphan: "skip",
	};
}
