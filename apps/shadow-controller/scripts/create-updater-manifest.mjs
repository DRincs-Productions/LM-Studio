import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const platformPatterns = [
  ["windows-x86_64", /-setup\.exe$/i],
  ["linux-x86_64", /\.appimage$/i],
];

function listAssetFiles(root, relativeDirectory = "") {
  return fs.readdirSync(path.join(root, relativeDirectory), { withFileTypes: true }).flatMap((entry) => {
    const relativePath = path.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) return listAssetFiles(root, relativePath);
    return entry.isFile() ? [{ name: entry.name, relativePath }] : [];
  });
}

export function createUpdaterManifest({ assetsDir, tag, repository, pubDate = new Date().toISOString() }) {
  if (!/^server-v\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(tag)) throw new Error(`Invalid server release tag: ${tag}`);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error(`Invalid GitHub repository: ${repository}`);
  const version = tag.slice("server-v".length);
  const files = listAssetFiles(assetsDir);
  const platforms = {};

  for (const [platform, pattern] of platformPatterns) {
    const bundle = files.find((file) => pattern.test(file.name));
    if (!bundle) throw new Error(`Missing updater bundle for ${platform}`);
    const signaturePath = path.join(assetsDir, `${bundle.relativePath}.sig`);
    if (!fs.existsSync(signaturePath)) throw new Error(`Missing signature for ${bundle.name}`);
    const signature = fs.readFileSync(signaturePath, "utf8").trim();
    if (!signature) throw new Error(`Empty signature for ${bundle.name}`);
    // GitHub release uploads normalize spaces in Tauri bundle names to dots.
    const releaseAssetName = bundle.name.replaceAll(" ", ".");
    const assetUrl = `https://github.com/${repository}/releases/download/${tag}/${encodeURIComponent(releaseAssetName)}`;
    platforms[platform] = { url: assetUrl, signature };
  }

  return { version, notes: `Shadow Controller ${version}`, pub_date: pubDate, platforms };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [assetsDir, tag, repository, requestedOutput] = process.argv.slice(2);
  if (!assetsDir || !tag || !repository) {
    throw new Error("Usage: node scripts/create-updater-manifest.mjs <assets-dir> <server-tag> <owner/repo> [output]");
  }
  const output = requestedOutput ?? path.join(assetsDir, "latest.json");
  const manifest = createUpdaterManifest({ assetsDir, tag, repository });
  fs.writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`);
}
