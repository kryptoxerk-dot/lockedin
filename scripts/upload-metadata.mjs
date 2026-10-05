/**
 * Put the token's image and description on IPFS, through pump.fun's own upload
 * endpoint, and record the URI launch.mjs bakes into the mint.
 *
 *   node scripts/upload-metadata.mjs                # show exactly what would go up
 *   node scripts/upload-metadata.mjs --execute      # upload, verify, record
 *
 * Reads brand/token-metadata.json (or --file). An empty twitter or telegram is
 * left out rather than filled with a placeholder: whatever goes up is permanent
 * and public. The upload is verified by fetching the URI back and comparing
 * every field, then the image, before anything is recorded.
 *
 * Run from the owner's own machine: pump's endpoint sits behind bot protection
 * that refuses most servers.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const execute = args.includes("--execute");
const fileArg = args.indexOf("--file");
const SOURCE = fileArg >= 0 ? args[fileArg + 1] : path.join(ROOT, "brand", "token-metadata.json");
const OUT = process.env.METADATA_STATE ?? path.join(ROOT, "state", "metadata.json");
const ENDPOINT = process.env.PUMP_IPFS_ENDPOINT ?? "https://pump.fun/api/ipfs";

const spec = JSON.parse(fs.readFileSync(SOURCE, "utf8"));
for (const key of ["name", "symbol", "description", "image"]) {
  if (!spec[key]?.trim()) throw new Error(`${SOURCE}: "${key}" is required`);
}
if (spec.name !== (process.env.LOCKEDIN_NAME ?? "Locked In") || spec.symbol !== (process.env.LOCKEDIN_SYMBOL ?? "LOCKEDIN")) {
  throw new Error("name/symbol differ from what launch.mjs will create; they must match");
}
const socials = {};
for (const key of ["website", "twitter", "telegram"]) {
  const value = (spec[key] ?? "").trim();
  if (!value) continue;
  if (!/^https:\/\/\S+$/.test(value)) throw new Error(`${key} must be a full https:// link, got "${value}"`);
  socials[key] = value;
}
const imagePath = path.resolve(ROOT, spec.image);
const image = fs.readFileSync(imagePath);
const imageSha = createHash("sha256").update(image).digest("hex");

console.log("=".repeat(72));
console.log(`LOCKED IN -- token metadata  (${execute ? "UPLOADING" : "preview only, nothing will be sent"})`);
console.log("=".repeat(72));
console.log(`  name         ${spec.name}`);
console.log(`  symbol       ${spec.symbol}`);
console.log(`  description  ${spec.description}`);
console.log(`  image        ${path.relative(ROOT, imagePath)}  (${image.length} bytes, sha256 ${imageSha.slice(0, 16)}…)`);
for (const key of ["website", "twitter", "telegram"]) console.log(`  ${key.padEnd(12)} ${socials[key] ?? "(omitted)"}`);

if (fs.existsSync(OUT)) {
  const recorded = JSON.parse(fs.readFileSync(OUT, "utf8"));
  console.log(`\n  already uploaded: ${recorded.metadataUri}`);
  console.log(`  delete ${path.relative(ROOT, OUT)} to upload a different version.`);
  process.exit(0);
}
if (!execute) {
  console.log("\n  Nothing was sent. Review the above; it is permanent once launched.");
  console.log("  Re-run with --execute to upload.");
  process.exit(0);
}

const form = new FormData();
form.append("file", new Blob([image], { type: "image/png" }), path.basename(imagePath));
form.append("name", spec.name);
form.append("symbol", spec.symbol);
form.append("description", spec.description);
for (const [key, value] of Object.entries(socials)) form.append(key, value);
form.append("showName", "true");

const response = await fetch(ENDPOINT, { method: "POST", body: form });
if (!response.ok) throw new Error(`upload refused: HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
const result = await response.json();
const uri = result.metadataUri;
if (!uri?.startsWith("https://")) throw new Error(`unexpected response: ${JSON.stringify(result).slice(0, 300)}`);
console.log(`\n  uploaded: ${uri}`);

// Read it back the way a wallet or explorer will, rather than trusting the reply.
let published = null;
for (let i = 0; i < 10 && !published; i++) {
  try {
    const r = await fetch(uri);
    if (r.ok) published = await r.json();
  } catch {}
  if (!published) await new Promise((r) => setTimeout(r, 3000));
}
if (!published) throw new Error(`could not read ${uri} back yet; re-run later before launching`);
const mismatched = ["name", "symbol", "description", ...Object.keys(socials)]
  .filter((key) => (published[key] ?? "") !== (key in socials ? socials[key] : spec[key]));
if (mismatched.length) throw new Error(`published metadata differs in: ${mismatched.join(", ")}`);
const publishedImage = Buffer.from(await (await fetch(published.image)).arrayBuffer());
if (createHash("sha256").update(publishedImage).digest("hex") !== imageSha) {
  throw new Error(`the image at ${published.image} is not the file that was uploaded`);
}
console.log("  verified: every field and the image read back exactly");

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), metadataUri: uri, metadata: published, imageSha }, null, 2) + "\n");
console.log(`\n  recorded in ${path.relative(ROOT, OUT)}`);
console.log(`  launch with:  node --env-file=.env.mainnet scripts/launch.mjs --uri ${uri}`);
