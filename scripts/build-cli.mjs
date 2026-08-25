import * as esbuild from "esbuild";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
mkdirSync(dist, { recursive: true });

const bundled = join(dist, "admin.cjs");
const blob = join(dist, "sea-prep.blob");
const seaConfig = join(dist, "sea-config.json");
const outfile = join(dist, process.platform === "win32" ? "mail-relay.exe" : "mail-relay");

await esbuild.build({
  absWorkingDir: root,
  entryPoints: ["src/admin.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: bundled,
  logOverride: { "empty-import-meta": "silent" },
  define: {
    __WORKER_URL__: JSON.stringify(process.env.WORKER_URL ?? ""),
    __ADMIN_BEARER_TOKEN__: JSON.stringify(process.env.ADMIN_BEARER_TOKEN ?? ""),
  },
});

writeFileSync(
  seaConfig,
  `${JSON.stringify(
    {
      main: bundled,
      output: blob,
      disableExperimentalSEAWarning: true,
    },
    null,
    2,
  )}\n`,
);

const run = (cmd, args) => {
  const result = spawnSync(cmd, args, { stdio: "inherit" });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
};

run(process.execPath, ["--experimental-sea-config", seaConfig]);
copyFileSync(process.execPath, outfile);

const require = createRequire(import.meta.url);
const postjectCli = require.resolve("postject/dist/cli.js");
const postjectArgs = [
  postjectCli,
  outfile,
  "NODE_SEA_BLOB",
  blob,
  "--sentinel-fuse",
  "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
];
if (process.platform === "darwin") {
  postjectArgs.push("--macho-segment-name", "NODE_SEA");
}
run(process.execPath, postjectArgs);

chmodSync(outfile, 0o755);
console.log(`wrote ${outfile}`);
