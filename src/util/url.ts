/**
 * Validation for URLs an admin enters in a slash command. A bearer token or
 * API key is sent to them, so they must use https. Plain http is accepted only
 * for loopback and the reserved .test/.localhost names (local development) and,
 * when allowed, for in-cluster service names (*.svc, *.svc.cluster.local).
 */
export function checkSecureUrl(
  raw: string,
  opts: { allowClusterHttp?: boolean } = {},
): { ok: true; url: URL } | { ok: false; error: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: "Invalid URL format." };
  }
  if (url.protocol === "https:") return { ok: true, url };
  if (url.protocol !== "http:") return { ok: false, error: "URL must use https://." };
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  const local =
    host === "localhost" || host === "127.0.0.1" || host === "[::1]" ||
    host.endsWith(".localhost") || host.endsWith(".test");
  const cluster = !!opts.allowClusterHttp && /\.svc(\.cluster\.local)?$/.test(host);
  if (local || cluster) return { ok: true, url };
  return { ok: false, error: "URL must use https:// (the API key would otherwise be sent in clear text)." };
}
