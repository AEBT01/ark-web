#!/usr/bin/env node
/**
 * launch-browseros-detached.js —— 真正脱离当前会话地启动 BrowserOS
 *
 * 为什么需要它：`cmd /c start ""` 看似后台启动，进程仍属于当前进程组 ——
 * 从脚本/工具里调用时，一旦调用方退出，浏览器可能被一并回收（实测反复出现：
 * 起来 20 秒内正常，下一个命令就发现它已经没了）。
 *
 * 做法与开机自启同一套：写一个 VBS，用 WScript.Shell.Run(..., 0, False) 启动，
 * 该进程归属 wscript 且窗口隐藏，之后与调用方再无关系。
 *
 * 注意：.vbs 必须写成 UTF-16LE + BOM —— Windows 脚本宿主不按 UTF-8 解析脚本，
 * 而本机路径含中文（C:\Users\画扇\...），按 GBK 解码会得到乱码路径而静默失败。
 *
 * 用法: node scripts/launch-browseros-detached.js [--kill-first]
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const CMD = path.join(ROOT, 'scripts', 'launch-browseros.cmd');
const VBS = path.join(os.tmpdir(), 'ark-launch-browseros.vbs');
const KILL_FIRST = process.argv.includes('--kill-first');

if (!fs.existsSync(CMD)) {
  console.error('找不到启动器: ' + CMD);
  process.exit(1);
}

if (KILL_FIRST) {
  const r = spawnSync('taskkill', ['/IM', 'chrome.exe', '/F'], { encoding: 'utf8' });
  console.log('已结束既有浏览器进程' + (r.status === 0 ? '' : '（没有在跑的实例）'));
  // 给 Chromium 一点时间释放 profile 锁与调试端口
  spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},2500)'], { timeout: 4000 });
}

if (process.platform !== 'win32') {
  console.log('非 Windows：直接运行 scripts/launch-browseros.cmd 的等价命令即可（本脚本只解决 Windows 的进程归属问题）。');
  process.exit(0);
}

const vbs = [
  "' 由 scripts/launch-browseros-detached.js 生成：隐藏窗口、脱离调用方会话地启动 BrowserOS",
  'Option Explicit',
  'Dim sh',
  'Set sh = CreateObject("WScript.Shell")',
  'sh.Run "cmd /c ""' + CMD + '""", 0, False',
  ''
].join('\r\n');

fs.writeFileSync(VBS, '\ufeff' + vbs, 'utf16le');
const r = spawnSync('wscript', [VBS], { encoding: 'utf8' });
if (r.error) {
  console.error('启动失败: ' + r.error.message);
  process.exit(1);
}
console.log('已发出启动指令（脱离当前会话，窗口隐藏）');
console.log('');
console.log('接下来的自检:');
console.log('  node scripts/verify-all.js            # 全量（会自动跳过缺条件的层）');
console.log('  node client/browser-client.js status  # 只看插件是否连上');
