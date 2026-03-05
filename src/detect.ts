export function detectCloudflareWorker(): boolean {
	try {
		return typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers";
	} catch {
		return false;
	}
}

export function detectNode(): boolean {
	try {
		return typeof process !== "undefined" && !!process.versions?.node;
	} catch {
		return false;
	}
}

/**
 * Detect a browser environment.
 *
 * Returns `true` when `window` and `document` exist (standard browser globals)
 * **and** the environment is not a Cloudflare Worker (which also has `navigator`
 * but not `window`/`document`).
 */
export function detectBrowser(): boolean {
	try {
		const g = globalThis as Record<string, unknown>;
		return (
			typeof g.window !== "undefined" &&
			typeof g.document !== "undefined" &&
			!detectCloudflareWorker() &&
			!detectNode()
		);
	} catch {
		return false;
	}
}
