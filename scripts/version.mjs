#!/usr/bin/env node
/**
 * 版本号同步 / 校验工具。
 *
 *   node scripts/version.mjs         校验 src/version.ts 与 package.json 是否一致
 *   node scripts/version.mjs --sync  以 src/version.ts 为准写入 package.json
 *
 * 版本号的唯一来源是 src/version.ts，package.json 只是它的副本。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const versionFile = join(root, "src", "version.ts");
const pkgFile = join(root, "package.json");

/** 从 src/version.ts 里取出 VERSION 常量 */
function readVersion() {
  const src = readFileSync(versionFile, "utf8");
  const m = src.match(/export\s+const\s+VERSION\s*=\s*["']([^"']+)["']/);
  if (!m) {
    console.error(`✗ 无法在 src/version.ts 中找到 VERSION 常量`);
    process.exit(1);
  }
  return m[1];
}

const version = readVersion();
const pkg = JSON.parse(readFileSync(pkgFile, "utf8"));
const sync = process.argv.includes("--sync");

if (pkg.version === version) {
  console.log(`✓ 版本号一致：${version}`);
  process.exit(0);
}

if (sync) {
  pkg.version = version;
  writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + "\n", "utf8");
  console.log(`✓ 已同步 package.json 版本号：${pkg.version} → ${version}`);
  process.exit(0);
}

console.error(
  [
    `✗ 版本号不一致：`,
    `    src/version.ts : ${version}`,
    `    package.json   : ${pkg.version}`,
    ``,
    `请执行 npm run version:sync 同步，或手动修改 package.json。`,
  ].join("\n"),
);
process.exit(1);
