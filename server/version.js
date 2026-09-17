'use strict';
/**
 * 服务端读版本号 —— 权威来源是仓库根的 VERSION（由 scripts/bump-version.js 统一维护）。
 * 单独成文件是因为服务端多处要报版本（/status、/settings、预检），不该各自读文件。
 */
const fs = require('fs');
const path = require('path');

function read() {
  try {
    const v = fs.readFileSync(path.join(__dirname, '..', 'VERSION'), 'utf8').trim();
    if (v) return v;
  } catch (e) { /* 回退到 package.json */ }
  try { return require('./package.json').version; } catch (e) { return '0.0.0'; }
}

module.exports = { read };
