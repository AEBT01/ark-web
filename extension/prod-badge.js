/**
 * prod-badge.js —— 商品发布页的「生产线面板」入口（URL 绑定自动触发）
 *
 * 用户规格：扩展 URL 绑定拼多多商品发布页，进入该页面即自动感知并给出面板入口。
 * 实现（合规且稳）：
 *   · 只在 mms.pinduoduo.com 注入（manifest 已限定）
 *   · 页面就绪后在右下角显示一个小按钮；点击 = 有效用户手势 ⇒ 打开扩展 side panel
 *   · 面板不可用时给出明确原因（不静默失败）
 */
(function () {
  if (window.__arkProdBadge) return;
  window.__arkProdBadge = true;

  const ID = 'ark-prod-badge';
  function mount() {
    if (document.getElementById(ID)) return;
    const b = document.createElement('div');
    b.id = ID;
    b.textContent = '生产面板';
    b.title = '打开假一罚十生产线面板（点此）';
    b.style.cssText = [
      'position:fixed', 'right:16px', 'bottom:16px', 'z-index:2147483646',
      'background:#2f81f7', 'color:#fff', 'font:12px/1 -apple-system,"Microsoft YaHei",system-ui',
      'padding:8px 12px', 'border-radius:16px', 'cursor:pointer',
      'box-shadow:0 2px 10px rgba(0,0,0,.35)', 'user-select:none',
    ].join(';');
    b.onclick = async () => {
      try {
        const r = await chrome.runtime.sendMessage({ type: 'ark-open-production-panel' });
        if (!r || !r.ok) b.textContent = '面板不可用: ' + ((r && r.error) || '未知');
        else b.textContent = '已打开';
        setTimeout(() => { b.textContent = '生产面板'; }, 2500);
      } catch (e) {
        b.textContent = '扩展未就绪';
        setTimeout(() => { b.textContent = '生产面板'; }, 2500);
      }
    };
    document.body.appendChild(b);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
