/**
 * 高风险动作判定 —— 唯一定义处
 *
 * 为什么单独成模块：这份关键词表原本抄了两份（semantic.js 的 HIGH_RISK_RE 与
 * tool-registry.js 的 RISK_TEXT_RE），措辞略有出入。两份副本对同一个按钮可能给出
 * 不同结论，而这种不一致在安全判定上尤其危险。现在只有一份。
 *
 * 判定思路：看"这个动作作用在什么文字上"。文字里出现支付/删除/发布发送一类词，
 * 就认为该动作需要用户确认。这是启发式，不是完备的——它的价值在于把"手滑点错"
 * 挡在人这一侧，而不是替代真正的权限系统。
 */
// 双语词表：旧版只有中文词，英文站点（Delete / Pay / Send / Unsubscribe）完全不设防。
// 判定的是"动作作用在什么文字上"，所以语言必须覆盖到实际会遇到的界面。
/** 高风险动作词表（中英双语）。
 *  旧版只有中文词 —— 英文站点（Delete / Pay / Send / Unsubscribe）完全不设防。
 *  用数组而不是一行超长正则：便于增删、也避免转义被反复编辑写坏（历史上真发生过）。
 */
const HIGH_RISK_WORDS = [
  // 中文
  '支付', '付款', '下单', '购买', '立即购买', '结算', '提交订单', '确认支付', '确认下单',
  '删除', '移除', '清空', '撤销', '注销', '解绑', '解除绑定',
  '发布', '发表', '发送', '投递', '提交', '确认', '授权',
  '转账', '提现', '充值', '付款码',
  '修改密码', '重置密码', '退订', '取消订阅', '解约',
  // 英文（不区分大小写；宁可多问一句，也不要漏掉不可撤销的动作）
  'delete', 'remove', 'discard', 'trash', 'destroy',
  'pay', 'payment', 'checkout', 'buy', 'purchase', 'place order', 'submit order',
  'confirm payment', 'confirm order', 'confirm purchase',
  'send', 'post', 'publish', 'submit', 'confirm',
  'transfer', 'withdraw', 'top up',
  'unsubscribe', 'cancel subscription', 'deactivate', 'revoke', 'deauthorize',
  'reset password', 'change password', 'sign out', 'logout', 'log out'
];
const HIGH_RISK_RE = new RegExp('(' + HIGH_RISK_WORDS.join('|') + ')', 'i');

/**
 * 结构性判据（不依赖文案语言）：只看元素角色就能确定"这是提交/支付动作"。
 * 补它是因为图标按钮（纯图标无文字）与英文界面靠词表都可能漏，而这类元素的结构特征是稳定的。
 */
const HIGH_RISK_SELECTOR_RE = /(type\s*=\s*["']?submit|formaction|name\s*=\s*["']?(delete|remove|pay|submit)|data-(action|confirm)\s*=\s*["']?(delete|remove|pay|submit))/i;

/** 需要过门禁的工具：凡是"能对外产生副作用"的都算，避免换工具绕过 */
const GATED_TOOLS = new Set([
  'click', 'semantic_click', 'cdp_click',
  'type_text', 'semantic_fill', 'press_key', 'select_option',
  'set_storage',
  // 脚本执行与原生直通：门禁对它们只做"明显绕过形态"的启发式拦截
  // （代码里既要点按又出现高风险词），正常只读诊断不受影响
  'evaluate', 'cdp_eval', 'ark_api'
]);

function isHighRisk(text) { return HIGH_RISK_RE.test(String(text == null ? '' : text)); }

module.exports = { HIGH_RISK_RE, HIGH_RISK_SELECTOR_RE, GATED_TOOLS, isHighRisk };
