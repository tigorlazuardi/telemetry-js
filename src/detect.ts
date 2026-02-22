export function detectCloudflareWorker(): boolean {
  try {
    return (
      typeof navigator !== "undefined" &&
      navigator.userAgent === "Cloudflare-Workers"
    );
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
