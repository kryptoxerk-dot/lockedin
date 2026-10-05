export function requireLocalValidator(rpc) {
  if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(rpc).hostname)) {
    throw new Error("This integration test only runs against a local disposable validator");
  }
}
