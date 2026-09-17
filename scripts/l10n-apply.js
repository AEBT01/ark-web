/**
 * BrowserOS 汉化 · 第三步：把翻译字典打到扩展文件上
 *
 * 用法: node scripts/l10n-browseros.js apply [--dry]
 *   · 备份原文件到 scripts/l10n-backup/<ext-id>/...（已有备份则不覆盖，保留最早的原始版）
 *   · 字典按"英文串长度降序"应用，避免短串破坏长句
 *   · 每条记录替换次数；0 次命中的条目会列出（可能是字面量形态不同或该页无此文案）
 *   · 打完补丁逐文件 node --check（JS 语法自证没打坏）
 * 回滚: node scripts/l10n-browseros.js restore
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const UD = path.join(os.homedir(), 'AppData', 'Local', 'BrowserClaw', 'User Data');
const NEO = path.join(UD, 'Default', 'Extensions', 'pjimfkbpehlcllblajnpfamdfjhhlgkc', '0.2.17.0_0');
const FB = path.join(UD, 'Default', 'Extensions', 'adlpneommgkgeanpaekgoaolcpncohkf', '57.0.0.0_0');
const BACKUP = path.join(__dirname, 'l10n-backup');

const TARGETS = [
  { root: NEO, files: ['chunks/newtab-DxAJAzkM.js', 'content-scripts/recorder.js', 'background.js'] },
  { root: FB, files: ['popup.js', 'background.js'] }
];

const dict = JSON.parse(fs.readFileSync(path.join(__dirname, 'l10n-dict.json'), 'utf8'))
  // 长串优先，防止 "Submit " 吃掉 "Submit feedback" 的前缀
  .sort((a, b) => b[0].length - a[0].length);

const DRY = process.argv.includes('--dry');
const DO_RESTORE = process.argv.includes('restore');

function backup(root, rel) {
  const src = path.join(root, rel);
  const dst = path.join(BACKUP, path.basename(root), rel);
  if (fs.existsSync(dst)) return;            // 保留最早的原始版本
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

function restore() {
  let n = 0;
  for (const t of TARGETS) {
    for (const rel of t.files) {
      const bak = path.join(BACKUP, path.basename(t.root), rel);
      const dst = path.join(t.root, rel);
      if (fs.existsSync(bak)) { fs.copyFileSync(bak, dst); n++; }
    }
  }
  console.log('已还原 ' + n + ' 个文件（恢复汉化前原始版本）。重启浏览器生效。');
}

function apply() {
  let totalPairs = 0, hitPairs = 0;
  const misses = [];
  for (const t of TARGETS) {
    for (const rel of t.files) {
      const abs = path.join(t.root, rel);
      if (!fs.existsSync(abs)) { console.log('跳过（不存在）: ' + rel); continue; }
      if (!DRY) backup(t.root, rel);
      let src = fs.readFileSync(abs, 'utf8');
      const original = src;
      let fileHits = 0;
      for (const [en, zh] of dict) {
        // 条目自带引号（上下文限定形态，如 label:"Click"）→ 原样精确替换；
        // 普通词条 → 引号定界替换，只命中字符串字面量，绝不碰标识符/属性名/枚举名
        const quoted = /["'`]/.test(en);
        // 模板字面量前缀（如 "Theme: ${"）：补尾引号会失配，追加裸替换通道
        const tmpl = quoted ? false : /\$\{\s*$/.test(en);
        const variants = quoted ? [en] : (tmpl ? [en] : ['"' + en + '"', "'" + en + "'", '`' + en + '`']);
        let count = 0;
        for (const v of variants) {
          if (!src.includes(v)) continue;
          count += src.split(v).length - 1;
          // 上下文条目/模板前缀：整体替换；普通条目保留首尾引号
          src = src.split(v).join(quoted || tmpl ? zh : (v[0] + zh + v[v.length - 1]));
        }
        if (count > 0) {
          fileHits += count;
          totalPairs += 1;
          hitPairs += 1;
        }
      }
      if (src !== original && !DRY) {
        fs.writeFileSync(abs, src, 'utf8');
        // 语法自证：JS 文件打完补丁必须仍可解析
        try {
          execFileSync(process.execPath, ['--check', abs], { stdio: 'pipe' });
        } catch (e) {
          console.error('!! 语法校验失败，回滚该文件: ' + rel);
          fs.writeFileSync(abs, original, 'utf8');
          process.exitCode = 1;
          return;
        }
      }
      console.log((DRY ? '[dry] ' : '') + rel + '  替换 ' + fileHits + ' 处');
    }
  }
  // 汇总未命中的字典条目
  console.log('\n命中字典条目: ' + hitPairs + ' / ' + dict.length);
  for (const [en] of dict) {
    const found = TARGETS.some(t => t.files.some(rel => {
      const abs = path.join(t.root, rel);
      try { return fs.readFileSync(abs, 'utf8').indexOf(en) >= 0; } catch (e) { return false; }
    }));
    if (!found) misses.push(en);
  }
  if (misses.length) {
    console.log('未命中条目（字面量形态不同或已不存在，共 ' + misses.length + ' 条）:');
    misses.forEach(m => console.log('  · ' + m));
  }
  if (!DRY) console.log('\n完成。重启浏览器生效。');
}

if (DO_RESTORE) restore();
else apply();
