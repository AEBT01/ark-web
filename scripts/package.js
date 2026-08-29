#!/usr/bin/env node
/**
 * package.js — Ark Web 发布打包
 * 生成 dist/ark-web-v<版本>.zip, 包含可分发的最小工具链
 *
 * 用法: node scripts/package.js
 * 输出: dist/ark-web-vX.Y.Z.zip + 文件清单 + 校验和
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

// 版本号来自 manifest
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'extension', 'manifest.json'), 'utf8'));
const version = manifest.version;
const outName = `ark-web-v${version}`;
const stageDir = path.join(DIST, outName);

// 打包内容 (相对 ROOT)
const INCLUDES = [
  'extension/manifest.json',
  'extension/background.js',
  'extension/content.js',
  'extension/popup.html',
  'extension/popup.js',
  'extension/devtools.html',
  'extension/devtools.js',
  'extension/icons/icon16.png',
  'extension/icons/icon48.png',
  'extension/icons/icon128.png',
  'server/bridge-server.js',
  'server/audit.js',
  'server/audit-report.js',
  'server/package.json',
  'client/browser-client.js',
  'client/ark-fast.js',
  'scripts/check-endpoints.js',
  'scripts/smoke-test.js',
  'scripts/real-scenario-v3.js',
  'scripts/real-scenario-v4.js',
  'scripts/package.js',
  'ark.js',
  'start.bat',
  'start.sh',
  'README.md',
  'CHANGELOG.md',
  'SKILL.md',
  'LICENSE'
];

function main() {
  // 1. 清理旧的打包目录
  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(stageDir, { recursive: true });

  // 2. 复制文件
  const total = { files: 0, bytes: 0 };
  for (const rel of INCLUDES) {
    const src = path.join(ROOT, rel);
    if (!fs.existsSync(src)) {
      console.error(`✗ 缺少文件: ${rel}`);
      process.exit(1);
    }
    const dest = path.join(stageDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const data = fs.readFileSync(src);
    fs.writeFileSync(dest, data);
    total.files++;
    total.bytes += data.length;
  }

  // 3. 生成 zip (PowerShell Compress-Archive)
  const zipPath = path.join(DIST, `${outName}.zip`);
  console.log('正在压缩...');
  execFileSync('powershell.exe', [
    '-NoProfile', '-Command',
    `Compress-Archive -Path '${stageDir}\\*' -DestinationPath '${zipPath}' -Force`
  ], { stdio: 'pipe' });

  // 4. 校验和
  const hash = execFileSync('powershell.exe', [
    '-NoProfile', '-Command',
    `(Get-FileHash -Algorithm SHA256 '${zipPath}').Hash`
  ], { encoding: 'utf8' }).trim();

  const zipSize = fs.statSync(zipPath).size;

  // 5. 报告
  console.log('');
  console.log('=== 打包完成 ===');
  console.log(`版本:      ${version}`);
  console.log(`文件数:    ${total.files}`);
  console.log(`源文件:    ${(total.bytes / 1024).toFixed(1)} KB`);
  console.log(`ZIP:       ${(zipSize / 1024).toFixed(1)} KB`);
  console.log(`输出:      ${zipPath}`);
  console.log(`SHA256:    ${hash}`);
  console.log('');
  console.log('发布清单:');
  for (const rel of INCLUDES) {
    console.log(`  ${rel}`);
  }
}

main();
