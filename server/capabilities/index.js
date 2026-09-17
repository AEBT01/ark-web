/**
 * 能力清单 —— 服务"能做什么"的完整声明
 *
 * 新增能力只需：写一个 capabilities/xxx.js（声明 routes / tools），在下面加一行。
 * 不再需要改动 bridge-server.js 的任何 switch —— 那个 143 分支的巨型 switch 已在本次重构中拆解。
 */
module.exports = [
  require('./meta'),       // 存活探针 / 服务状态 / 缓存 / 批量 / 能力清单
  require('./session'),    // 多 agent 并行隔离
  require('./tabs'),       // 标签页与导航
  require('./dom'),        // 页面信息 / DOM 查询 / 脚本执行 / 等待
  require('./act'),        // 点击 / 输入 / 滚动等元素动作
  require('./capture'),    // 截图 / 快照 / PDF
  require('./state'),      // Cookie / Storage
  require('./network'),    // 网络观测与拦截
  require('./perf'),       // 性能 / 控制台 / DOM 变化 / 监控
  require('./emulate'),    // 设备与环境模拟
  require('./inspect'),    // 安全 / 无障碍 / SEO / 全量分析
  require('./debug'),      // 调试授权
  require('./semantic'),   // 语义层
  require('./kernel'),     // CDP 直连内核
  require('./agent'),      // 大脑与任务运行时
  require('./audit'),      // 审计引擎
  require('./settings'),   // 配置读写（密钥 / 预算 / 敏感名单 / 令牌轮换 / 首启自检）
  require('./extra')       // 手写补充（生成器不覆盖）
];
