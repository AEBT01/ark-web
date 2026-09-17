/**
 * 共享路径与常量 —— 原先散落在 bridge-server.js 顶部，
 * 被各能力模块的分支体引用。抽取出来的原因：
 *   能力模块由生成器产出，模块级常量必须在它们可解析的位置，
 *   否则运行时才报 "xxx is not defined"（静态语法检查发现不了）。
 */
const os = require('os');
const path = require('path');

const SERVER_DIR = path.join(__dirname, '..');          // server/
const PROJECT_DIR = path.join(SERVER_DIR, '..');        // ark-web/

// 令牌文件：首次启动自动生成并落盘(0600)，之后固定复用。
// 用户级共享路径的原因：目录里可能同时存在多份项目副本（开发仓库 / 技能安装目录），
// 各自生成令牌会导致"服务端与 CLI 令牌不一致"的 401。旧位置的 server/.ark-token 仍兼容读取。
const SHARED_TOKEN_DIR = path.join(os.homedir(), '.ark-web');
const SHARED_TOKEN_FILE = path.join(SHARED_TOKEN_DIR, 'token');
const LEGACY_TOKEN_FILE = path.join(SERVER_DIR, '.ark-token');
const TOKEN_FILE = SHARED_TOKEN_FILE;

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const EXTENSION_PROTOCOLS = new Set(['chrome-extension:', 'moz-extension:', 'safari-web-extension:']);

// agent 文件工具的沙箱根。定义在这里而不是各模块里，是为了让"沙箱范围"只有一个说法：
// 曾经 compaction 的 spill 落盘到 ~/.ark-web/spills（沙箱外），而 read_file 只能读
// ~/.ark-web/workspace —— 于是提示模型"用 read_file 取回完整内容"成了一句空话。
const WORKSPACE_DIR = path.join(SHARED_TOKEN_DIR, 'workspace');
/** spill 文件目录：必须在沙箱内，否则模型取不回来 */
const SPILL_DIR = path.join(WORKSPACE_DIR, '.spills');

module.exports = {
  SERVER_DIR, PROJECT_DIR,
  SHARED_TOKEN_DIR, SHARED_TOKEN_FILE, LEGACY_TOKEN_FILE, TOKEN_FILE,
  LOOPBACK_HOSTS, EXTENSION_PROTOCOLS,
  WORKSPACE_DIR, SPILL_DIR
};
