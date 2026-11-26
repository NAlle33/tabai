import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

/** Explicit source roots exclude generated bundles and personal stores. */
export function buildInputs(root) {
  const files = [];
  const visit = directory => {
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  for (const directory of ["src", "shared", "extension/src", "scripts", "extension/assets", "extension/icons"]) visit(directory);
  files.push("build.mjs", "package.json", "package-lock.json", "extension/manifest.json", "tsconfig.json",
    "extension/popup.html", "extension/offscreen.html", "extension/sidepanel.html", "extension/sidepanel.css");
  return files.map(file => relative(root, join(root, file)).replaceAll("\\", "/")).sort();
}

/** Hash build inputs only: never environment credentials or personal stores. */
export function buildIdentity(root, configuration) {
  const hash = createHash("sha256");
  hash.update(JSON.stringify(configuration));
  for (const file of buildInputs(root)) {
    hash.update(file);
    hash.update("\0"); hash.update(readFileSync(join(root, file))); hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

/** Recompute identity on every watch rebuild, watching all identity inputs even
 *  when they are not imports of this particular entry point. */
export function buildIdentityPlugin(root, configuration) {
  return { name: "build-identity", setup(build) {
    build.onLoad({ filter: /[/\\]shared[/\\]build-info\.ts$/ }, () => ({
      contents: `export const BUILD_ID = ${JSON.stringify(buildIdentity(root, configuration))};`,
      loader: "ts", watchFiles: buildInputs(root).map(file => join(root, file)),
    }));
  } };
}
