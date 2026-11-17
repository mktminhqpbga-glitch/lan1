import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createBridge } from "./lib/server.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const raw = process.argv[i];
  if (!raw.startsWith("--")) throw new Error("Expected --option value.");
  const index = raw.indexOf("=");
  const key = index < 0 ? raw.slice(2) : raw.slice(2, index);
  args[key] = index < 0 ? process.argv[++i] : raw.slice(index + 1);
  if (args[key] === undefined) throw new Error(`Missing value for ${key}`);
}
const directory = path.resolve(
  args["data-dir"] ||
    process.env.BRIDGE_DATA_DIR ||
    path.join(root, ".ai-bridge-data"),
);
fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
function credential(supplied, file) {
  if (supplied) {
    if (supplied.length < 24)
      throw new Error("Credential must contain at least 24 characters.");
    return supplied;
  }
  if (!fs.existsSync(file))
    fs.writeFileSync(file, crypto.randomBytes(32).toString("hex") + "\n", {
      flag: "wx",
      mode: 0o600,
    });
  const value = fs.readFileSync(file, "utf8").trim();
  if (value.length < 24)
    throw new Error(`Credential file is too short: ${file}`);
  return value;
}
const tokenFile = path.resolve(
  args["token-file"] ||
    process.env.BRIDGE_TOKEN_FILE ||
    path.join(root, ".ai-bridge-token"),
);
const apiFile = path.join(directory, "api-key");
const bridgeToken = credential(
  args.token || process.env.BRIDGE_TOKEN,
  tokenFile,
);
const apiKey = credential(
  args["api-key"] || process.env.BRIDGE_API_KEY,
  apiFile,
);
if (apiKey === bridgeToken)
  throw new Error("API and extension pairing credentials must differ.");
for (const executable of ["ffmpeg", "ffprobe"]) {
  try {
    execFileSync(executable, ["-version"], { stdio: "ignore", timeout: 10000 });
  } catch {
    throw new Error(`${executable} is required in PATH for media validation.`);
  }
}
const settingsFile = path.resolve(
  args["settings-file"] ||
    process.env.BRIDGE_SETTINGS_FILE ||
    path.join(root, "ai-bridge.settings.json"),
);
const settings = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
const port = Number(args.port || process.env.BRIDGE_PORT || 4317);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("Invalid TCP port.");
const bridge = createBridge({
  directory,
  apiKey,
  bridgeToken,
  settings,
  promptRoot: path.resolve(
    args["prompt-instructions-dir"] ||
      process.env.BRIDGE_PROMPT_INSTRUCTIONS_DIR ||
      path.join(root, "prompt-instructions"),
  ),
  allowedOrigins: (process.env.BRIDGE_ALLOWED_ORIGINS || "")
    .split(",")
    .filter(Boolean),
});
const origin = await bridge.listen(port);
console.log(`AI Bridge 0.5.0 listening at ${origin}`);
console.log(`Control Center: ${origin}/`);
console.log(
  `Extension pairing token: ${args.token || process.env.BRIDGE_TOKEN ? "supplied externally" : tokenFile}`,
);
console.log(
  `Local API key: ${process.env.BRIDGE_API_KEY || args["api-key"] ? "supplied externally" : apiFile}`,
);
console.log(
  "Credentials are never printed. No Chrome process or tab is opened.",
);
let closing = false;
async function stop() {
  if (closing) return;
  closing = true;
  await bridge.close();
  process.exit(0);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
