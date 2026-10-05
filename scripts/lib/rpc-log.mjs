/** Keep provider credentials out of operational logs and public receipts. */
export function rpcLabel(endpoint) {
  try { return new URL(endpoint).host; } catch { return "configured RPC"; }
}

export function rpcErrorMessage(error, endpoint, maxLength = 200) {
  let message = String(error?.message ?? error);
  message = message.replaceAll(endpoint, rpcLabel(endpoint));
  try {
    const url = new URL(endpoint);
    const credentials = [url.username, url.password, ...url.pathname.split("/"), ...url.searchParams.values()];
    for (const value of credentials.filter(value => value.length >= 8)) {
      message = message.replaceAll(value, "[redacted]");
    }
  } catch {}
  message = message.replace(/https?:\/\/[^\s"'<>]+/g, rpcLabel);
  return message.split("\n")[0].slice(0, maxLength);
}
