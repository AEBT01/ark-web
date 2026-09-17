#!/usr/bin/env node
/**
 * install-autostart.js —— 让服务随登录自动在后台跑起来
 *
 * 为什么需要：产品的冷启动路径不能是"打开终端敲 node server/bridge-server.js"。
 * 用户装了扩展、打开侧边栏，如果服务没起，界面上应该什么都说得清、并且下次开机自动就绪。
 *
 * 做法（Windows，不需要管理员权限）：在「启动」文件夹放一个 VBS，用它以隐藏窗口
 * 启动 node 并把输出重定向到 ~/.ark-web/server.log。VBS 里固化 node 绝对路径与仓库
 * 绝对路径 —— 不依赖 PATH，也不依赖当前工作目录。
 *
 * 用法：
 *   node scripts/install-autostart.js             # 预演：显示将写入什么
 *   node scripts/install-autostart.js --yes       # 安装（并立即启动一次）
 *   node scripts/install-autostart.js --status    # 看当前是否已安装、服务是否在跑
 *   node scripts/install-autostart.js --remove    # 卸载
 *
 * 非 Windows 平台：本脚本会提示改用 systemd/launchd，并给出最小示例（不臆造用户的发行版细节）。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SERVER_JS = path.join(ROOT, 'server', 'bridge-server.js');
const LOG_FILE = path.join(os.homedir(), '.ark-web', 'server.log');
const ENTRY_NAME = 'Ark Web 服务.vbs';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const YES = has('--yes');

function startupDir() {
  return path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
}
function entryPath() {
  return path.join(startupDir(), ENTRY_NAME);
}

/** 找到 node 可执行文件的绝对路径（不用 PATH 也能启动） */
function nodeExe() {
  if (process.env.ARK_NODE_EXE && fs.existsSync(process.env.ARK_NODE_EXE)) return process.env.ARK_NODE_EXE;
  const r = spawnSync('where', ['node'], { encoding: 'utf8', shell: false });
  const first = String(r.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
  if (first && fs.existsSync(first)) return first;
  return process.execPath;   // 当前解释器兜底
}

function vbsContent(exe) {
  const Q = 'Chr(34)';
  return [
    '\' Ark Web 服务 —— 登录时后台启动（由 scripts/install-autostart.js 生成）',
    '\' 卸载：node <仓库>/scripts/install-autostart.js --remove',
    'Option Explicit',
    'Dim sh, Q, cmd',
    'Set sh = CreateObject("WScript.Shell")',
    'Q = Chr(34)',
    'cmd = "cmd /c " & Q & Q & "' + exe + '" & Q & " " & Q & "' + SERVER_JS + '" & Q & " >> " & Q & "' + LOG_FILE + '" & Q & " 2>&1" & Q',
    'sh.Run cmd, 0, False',
    ''
  ].join('\r\n');
}

/** 服务是否在跑（只看回环 /health） */
function health() {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: 9333, path: '/health', method: 'GET', timeout: 2500 }, (res) => {
      let b = '';
      res.on('data', (d) => (b += d));
      res.on('end', () => resolve({ ok: res.statusCode === 200, body: b.slice(0, 200) }));
    });
    req.on('error', (e) => resolve({ ok: false, error: e.code || e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.end();
  });
}

async function main() {
  const isWin = process.platform === 'win32';
  const running = await health();

  if (has('--status')) {
    console.log('启动项: ' + (isWin && fs.existsSync(entryPath()) ? '已安装 → ' + entryPath() : '未安装'));
    console.log('服务状态: ' + (running.ok ? '在运行（127.0.0.1:9333）' : '未运行（' + (running.error || '无响应') + '）'));
    console.log('日志文件: ' + LOG_FILE + (fs.existsSync(LOG_FILE) ? '（' + (fs.statSync(LOG_FILE).size / 1024).toFixed(0) + ' KB）' : '（尚无）'));
    return;
  }

  if (has('--remove')) {
    if (!isWin) { console.log('非 Windows 平台：请删除你自建的服务单元。'); return; }
    const p = entryPath();
    if (fs.existsSync(p)) { fs.unlinkSync(p); console.log('已移除启动项: ' + p); }
    else console.log('启动项本就不存在。');
    return;
  }

  if (!isWin) {
    console.log('当前不是 Windows。请用系统服务管理器自启，最小示例（systemd 用户单元）：');
    console.log('  ~/.config/systemd/user/ark-web.service');
    console.log('  [Service]');
    console.log('  ExecStart=' + process.execPath + ' ' + SERVER_JS);
    console.log('  Restart=always');
    console.log('  [Install]');
    console.log('  WantedBy=default.target');
    console.log('  然后: systemctl --user enable --now ark-web');
    return;
  }

  // 检查服务端依赖：分发包不含 node_modules，缺 ws 时服务会在日志里静默退出
  //（"✓ 已启动"却是假成功）。这里提前说清楚，而不是让用户对着空白界面猜。
  {
    const wsDir = path.join(ROOT, 'server', 'node_modules', 'ws');
    if (!fs.existsSync(wsDir)) {
      console.error('✗ 缺少服务端依赖: ' + wsDir);
      console.error('  先执行: cd server && npm install   （或运行 npm --prefix server install）');
      console.error('  依赖装好后再运行本脚本。');
      process.exit(1);
    }
  }

  const exe = nodeExe();
  const content = vbsContent(exe);
  console.log('将写入启动项: ' + entryPath());
  console.log('  node  : ' + exe);
  console.log('  服务  : ' + SERVER_JS);
  console.log('  日志  : ' + LOG_FILE);
  console.log('  服务当前: ' + (running.ok ? '已在运行' : '未运行'));
  console.log('');
  if (!YES) {
    console.log('这是预演。加 --yes 才会写入并立即启动一次。');
    console.log('---- 启动项内容 ----');
    console.log(content);
    return;
  }

  fs.mkdirSync(startupDir(), { recursive: true });
  // 必须写成「UTF-16LE + BOM」：Windows 脚本宿主不按 UTF-8 解析 .vbs，
  // 而本机路径含中文（C:\Users\画扇\...），按 GBK 解码会得到乱码路径 → 静默启动失败。
  fs.writeFileSync(entryPath(), '\ufeff' + content, 'utf16le');
  console.log('✓ 启动项已写入（UTF-16LE，含中文路径安全）。');

  if (running.ok) {
    console.log('服务已在运行，跳过立即启动。');
  } else {
    const r = spawnSync('wscript', [entryPath()], { encoding: 'utf8' });
    if (r.error) console.log('立即启动失败（可手动双击启动项）: ' + r.error.message);
    await new Promise((res) => setTimeout(res, 2500));
    const after = await health();
    console.log(after.ok ? '✓ 服务已启动并在响应。' : '服务尚未响应，检查日志: ' + LOG_FILE);
  }
}

main().catch((e) => { console.error('安装失败:', e.message); process.exit(1); });
