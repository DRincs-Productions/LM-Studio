import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createUpdaterManifest } from "./create-updater-manifest.mjs";

test("creates signed platform entries for a stable server release", () => {
  const assetsDir = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-updater-"));
  try {
    const bundles = [
      ["nsis", "Shadow Controller_0.1.3_x64-setup.exe"],
      ["appimage", "Shadow Controller_0.1.3_amd64.AppImage"],
    ];
    for (const [directory, bundle] of bundles) {
      const bundleDirectory = path.join(assetsDir, directory);
      fs.mkdirSync(bundleDirectory);
      fs.writeFileSync(path.join(bundleDirectory, bundle), "bundle");
      fs.writeFileSync(path.join(bundleDirectory, `${bundle}.sig`), `signature:${bundle}\n`);
    }
    const manifest = createUpdaterManifest({ assetsDir, tag: "server-v0.1.3", repository: "DRincs-Productions/LM-Studio", pubDate: "2026-11-04T00:00:00Z" });
    assert.equal(manifest.version, "0.1.3");
    assert.equal(manifest.pub_date, "2026-11-04T00:00:00Z");
    assert.equal(Object.keys(manifest.platforms).length, 2);
    assert.match(manifest.platforms["windows-x86_64"].url, /server-v0\.1\.3\/Shadow%20Controller_0\.1\.3_x64-setup\.exe$/);
    assert.equal(manifest.platforms["linux-x86_64"].signature, "signature:Shadow Controller_0.1.3_amd64.AppImage");
  } finally {
    fs.rmSync(assetsDir, { recursive: true, force: true });
  }
});

test("rejects an unsigned artifact", () => {
  const assetsDir = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-updater-"));
  try {
    for (const [directory, bundle] of [["nsis", "app-setup.exe"], ["appimage", "app.AppImage"]]) {
      const bundleDirectory = path.join(assetsDir, directory);
      fs.mkdirSync(bundleDirectory);
      fs.writeFileSync(path.join(bundleDirectory, bundle), "bundle");
    }
    assert.throws(() => createUpdaterManifest({ assetsDir, tag: "server-v0.1.3", repository: "owner/repo" }), /Missing signature/);
  } finally {
    fs.rmSync(assetsDir, { recursive: true, force: true });
  }
});
