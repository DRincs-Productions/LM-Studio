import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createUpdaterManifest } from "./create-updater-manifest.mjs";

test("creates signed platform entries for a stable server release", () => {
  const assetsDir = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-updater-"));
  try {
    const bundles = ["Shadow.Controller_0.1.1_x64-setup.nsis.zip", "Shadow.Controller_0.1.1_amd64.AppImage.tar.gz"];
    for (const bundle of bundles) {
      fs.writeFileSync(path.join(assetsDir, bundle), "bundle");
      fs.writeFileSync(path.join(assetsDir, `${bundle}.sig`), `signature:${bundle}\n`);
    }
    const manifest = createUpdaterManifest({ assetsDir, tag: "server-v0.1.1", repository: "DRincs-Productions/LM-Studio", pubDate: "2026-11-04T00:00:00Z" });
    assert.equal(manifest.version, "0.1.1");
    assert.equal(manifest.pub_date, "2026-11-04T00:00:00Z");
    assert.equal(Object.keys(manifest.platforms).length, 2);
    assert.match(manifest.platforms["windows-x86_64"].url, /server-v0\.1\.1\/Shadow\.Controller_0\.1\.1_x64-setup\.nsis\.zip$/);
    assert.equal(manifest.platforms["linux-x86_64"].signature, "signature:Shadow.Controller_0.1.1_amd64.AppImage.tar.gz");
  } finally {
    fs.rmSync(assetsDir, { recursive: true, force: true });
  }
});

test("rejects an unsigned artifact", () => {
  const assetsDir = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-updater-"));
  try {
    for (const bundle of ["app.nsis.zip", "app.AppImage.tar.gz", "app.app.tar.gz"]) fs.writeFileSync(path.join(assetsDir, bundle), "bundle");
    assert.throws(() => createUpdaterManifest({ assetsDir, tag: "server-v0.1.1", repository: "owner/repo" }), /Missing signature/);
  } finally {
    fs.rmSync(assetsDir, { recursive: true, force: true });
  }
});
