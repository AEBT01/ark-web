/**
 * 单词级字典条目的枚举风险安检：
 * 形如  e[e.Click=2]="Click"  的 TS 反向枚举映射，裸替换会改变序列化名称，
 * 可能破坏录制/回放的比对逻辑。命中的条目必须改为上下文限定（label:"…"）。
 */
const fs = require('fs');
const files = [
  'C:/Users/画扇/AppData/Local/BrowserClaw/User Data/Default/Extensions/pjimfkbpehlcllblajnpfamdfjhhlgkc/0.2.17.0_0/chunks/newtab-DxAJAzkM.js',
  'C:/Users/画扇/AppData/Local/BrowserClaw/User Data/Default/Extensions/pjimfkbpehlcllblajnpfamdfjhhlgkc/0.2.17.0_0/content-scripts/recorder.js',
  'C:/Users/画扇/AppData/Local/BrowserClaw/User Data/Default/Extensions/pjimfkbpehlcllblajnpfamdfjhhlgkc/0.2.17.0_0/background.js',
  'C:/Users/画扇/AppData/Local/BrowserClaw/User Data/Default/Extensions/adlpneommgkgeanpaekgoaolcpncohkf/57.0.0.0_0/popup.js',
  'C:/Users/画扇/AppData/Local/BrowserClaw/User Data/Default/Extensions/adlpneommgkgeanpaekgoaolcpncohkf/57.0.0.0_0/background.js'
];
const srcs = files.map(f => { try { return fs.readFileSync(f, 'utf8'); } catch (e) { return ''; } });
const dict = JSON.parse(fs.readFileSync(__dirname + '/l10n-dict.json', 'utf8'));
const single = dict.filter(d => !d[0].includes(' ') || d[0] === 'Submit ');
console.log('单词级条目:', single.length);
let risky = 0;
for (const [en] of single) {
  const esc = en.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const enumPat = new RegExp('=\\d+\\]"' + esc + '"');
  const hits = [];
  srcs.forEach((s, i) => { if (s && enumPat.test(s)) hits.push(i); });
  if (hits.length) { risky++; console.log('枚举风险: ' + en + ' → 文件#' + hits.join(',')); }
}
console.log('安检完成，枚举风险条目: ' + risky);
