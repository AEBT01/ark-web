/**
 * Browser Debug Bridge — Popup Script
 */

class PopupController {
  constructor() {
    this.connected = false;
    this.cdpEnabled = false;
    this.currentTab = null;
    this.init();
  }

  init() {
    this.setupTabs();
    this.setupEventListeners();
    this.checkConnection();
    this.loadPageInfo();
  }

  // ============ Tab 切换 ============

  setupTabs() {
    document.querySelectorAll('.tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById(`panel-${tab.dataset.panel}`).classList.add('active');
      });
    });
  }

  // ============ 事件监听 ============

  setupEventListeners() {
    // 刷新按钮
    document.getElementById('refreshBtn').addEventListener('click', () => {
      this.checkConnection();
      this.loadPageInfo();
    });

    // 截图
    document.getElementById('screenshotBtn').addEventListener('click', () => {
      this.sendMessage({ type: 'screenshot' }, (response) => {
        if (response?.dataUrl) {
          const a = document.createElement('a');
          a.href = response.dataUrl;
          a.download = `screenshot-${Date.now()}.png`;
          a.click();
        }
      });
    });

    // A11y 检查
    document.getElementById('a11yBtn').addEventListener('click', () => {
      this.sendMessage({ type: 'a11y-check' }, (response) => {
        console.log('A11y results:', response);
        alert(JSON.stringify(response, null, 2));
      });
    });

    // SEO 检查
    document.getElementById('seoBtn').addEventListener('click', () => {
      this.sendMessage({ type: 'seo-check' }, (response) => {
        console.log('SEO results:', response);
        alert(JSON.stringify(response, null, 2));
      });
    });

    // 安全检查
    document.getElementById('securityBtn').addEventListener('click', () => {
      this.sendMessage({ type: 'security-check' }, (response) => {
        console.log('Security results:', response);
        alert(JSON.stringify(response, null, 2));
      });
    });

    // 性能刷新
    document.getElementById('refreshPerfBtn')?.addEventListener('click', () => {
      this.loadPerformance();
    });

    // 设备模拟
    document.querySelectorAll('[data-device]').forEach(btn => {
      btn.addEventListener('click', () => {
        this.sendMessage({ type: 'simulate-device', data: { device: btn.dataset.device } }, (response) => {
          console.log('Device:', response);
          if (response?.error) alert(`设备模拟失败: ${response.error}`);
        });
      });
    });

    // 清除设备模拟
    document.getElementById('clearDeviceBtn')?.addEventListener('click', () => {
      this.sendMessage({ type: 'clear-device' }, (response) => {
        if (response?.error) alert(response.error);
      });
    });

    // CDP 调试开关
    document.getElementById('cdpToggleBtn')?.addEventListener('click', () => {
      const btn = document.getElementById('cdpToggleBtn');
      if (this.cdpEnabled) {
        btn.textContent = '启用调试';
        btn.disabled = true;
        this.sendMessage({ type: 'cdp-detach-all' }, () => {
          this.cdpEnabled = false;
          btn.disabled = false;
          this.updateCdpStatus(false, []);
        });
      } else {
        btn.textContent = '连接中...';
        btn.disabled = true;
        this.sendMessage({ type: 'cdp-attach-all' }, (response) => {
          btn.disabled = false;
          const attached = response?.attached || 0;
          this.cdpEnabled = attached > 0;
          if (this.cdpEnabled) {
            btn.textContent = '关闭调试';
          } else {
            btn.textContent = '启用调试';
          }
          this.updateCdpStatus(this.cdpEnabled, response?.results || []);
          if (attached === 0 && response?.results?.length) {
            alert(`启用失败。原因示例: ${response.results[0]?.reason || '未知'}\n\n提示: 需要在 Chrome 中点击本弹窗授权调试, 且 chrome:// 等系统页面无法调试。`);
          }
        });
      }
    });

    // 深色模式
    document.getElementById('darkModeBtn')?.addEventListener('click', () => {
      this.sendMessage({
        type: 'emulate-media',
        data: { features: [{ name: 'prefers-color-scheme', value: 'dark' }] }
      }, (response) => {
        if (response?.error) alert(`失败: ${response.error}`);
        else if (response?.method === 'css-fallback') console.warn('CDP 未启用, 深色模式为 CSS 近似模拟');
      });
    });

    // 动效减半
    document.getElementById('reducedMotionBtn')?.addEventListener('click', () => {
      this.sendMessage({
        type: 'emulate-media',
        data: { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] }
      }, (response) => {
        if (response?.error) alert(`失败: ${response.error}`);
      });
    });

    // 清除媒体模拟
    document.getElementById('clearMediaBtn')?.addEventListener('click', () => {
      this.sendMessage({ type: 'emulate-media', data: { features: [] } });
    });

    // Cookies
    document.getElementById('getCookiesBtn')?.addEventListener('click', () => {
      this.sendMessage({ type: 'get-cookies' }, (response) => {
        console.log('Cookies:', response);
        alert(JSON.stringify(response, null, 2));
      });
    });

    // localStorage
    document.getElementById('getStorageBtn')?.addEventListener('click', () => {
      this.sendMessage({ type: 'get-local-storage' }, (response) => {
        console.log('localStorage:', response);
        alert(JSON.stringify(response, null, 2));
      });
    });

    // 执行 JS
    document.getElementById('evaluateBtn')?.addEventListener('click', () => {
      const code = prompt('输入要执行的 JavaScript 代码:');
      if (code) {
        this.sendMessage({ type: 'evaluate', data: { code } }, (response) => {
          console.log('Result:', response);
          alert(JSON.stringify(response, null, 2));
        });
      }
    });
  }

  // ============ 连接状态 ============

  async checkConnection() {
    try {
      const response = await this.sendMessageAsync({ type: 'get-status' });
      this.connected = response?.connected || false;
      this.cdpEnabled = response?.cdp?.attachedTabs?.length > 0;
      if (response?.cdp?.attachedTabs?.length > 0) {
        this.updateCdpStatus(true, response.cdp.attachedTabs.map(id => ({ tabId: id })));
      }
    } catch {
      this.connected = false;
    }

    const dot = document.getElementById('statusDot');
    const text = document.getElementById('statusText');

    if (this.connected) {
      dot.classList.add('connected');
      text.textContent = '已连接到 Bridge Server';
      text.classList.add('connected');
    } else {
      dot.classList.remove('connected');
      text.textContent = '未连接';
      text.classList.remove('connected');
    }
  }

  updateCdpStatus(enabled, tabs) {
    const dot = document.getElementById('cdpDot');
    const text = document.getElementById('cdpText');
    const detail = document.getElementById('cdpDetail');
    const btn = document.getElementById('cdpToggleBtn');

    if (enabled) {
      dot.classList.add('connected');
      text.textContent = `调试器已启用 (${tabs?.length || 0} 个标签页)`;
      text.classList.add('connected');
      if (btn) btn.textContent = '关闭调试';
      if (detail) {
        const urls = (tabs || []).slice(0, 5).map(t => t.url || t.tabId || '').filter(Boolean).join('\n');
        detail.textContent = urls
          ? `已连接标签页:\n${urls}${tabs.length > 5 ? `\n...等 ${tabs.length} 个` : ''}`
          : '已启用。现在可以通过 AI/HTTP API 获得全部高级能力。';
      }
    } else {
      dot.classList.remove('connected');
      text.textContent = '调试器未启用';
      text.classList.remove('connected');
      if (btn) btn.textContent = '启用调试';
      if (detail) {
        detail.textContent = '未启用。启用后可获得: 真实鼠标/键盘事件、整页截图、真实设备与媒体模拟、网络响应体、异步 JS 执行。\n\n注意: Chrome 136+ 需要先点击「启用调试」按钮授权。';
      }
    }
  }

  // ============ 页面信息 ============

  async loadPageInfo() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      this.currentTab = tab;

      document.getElementById('pageTitle').textContent = tab.title || '-';
      document.getElementById('pageUrl').textContent = tab.url || '-';

      // 获取 DOM 信息
      this.sendMessage({ type: 'get-dom' }, (response) => {
        if (response && !response.error) {
          document.getElementById('domCount').textContent = response.elements || 0;
          document.getElementById('resourceCount').textContent = response.scripts || 0;
        }
      });

      // 获取性能信息
      this.loadPerformance();

      // 获取控制台日志
      this.loadConsoleLogs();

      // 获取网络日志
      this.loadNetworkLogs();
    } catch (e) {
      console.error('Failed to load page info:', e);
    }
  }

  async loadPerformance() {
    this.sendMessage({ type: 'get-performance' }, (response) => {
      if (response && !response.error) {
        if (response.navigation) {
          document.getElementById('loadTime').textContent = `${response.navigation.loadComplete}ms`;
        }
        if (response.memory) {
          document.getElementById('memoryUsage').textContent = `${response.memory.used}MB`;
        }

        // Web Vitals
        this.sendMessage({ type: 'get-web-vitals' }, (vitals) => {
          if (vitals && !vitals.error) {
            this.updateVitals(vitals);
          }
        });

        // 资源统计
        if (response.resources) {
          const stats = document.getElementById('resourceStats');
          if (stats) {
            let html = '<div class="card"><div class="label">总数: ' + response.resources.total + '</div></div>';
            for (const [type, data] of Object.entries(response.resources.byType)) {
              html += `<div class="card"><div class="label">${type}: ${data.count} 个</div></div>`;
            }
            stats.innerHTML = html;
          }
        }
      }
    });
  }

  updateVitals(vitals) {
    const setVital = (id, tagId, value, rating) => {
      const el = document.getElementById(id);
      const tag = document.getElementById(tagId);
      if (el) el.textContent = value || '-';
      if (tag) {
        tag.innerHTML = rating ? `<span class="tag ${rating === 'good' ? 'good' : rating === 'needs-improvement' ? 'warn' : 'error'}">${rating}</span>` : '';
      }
    };

    setVital('lcpValue', 'lcpTag', vitals.LCP ? `${vitals.LCP}ms` : '-', vitals.summary?.LCP);
    setVital('clsValue', 'clsTag', vitals.CLS?.toFixed(4) || '-', vitals.summary?.CLS);
    setVital('ttfbValue', 'ttfbTag', vitals.TTFB ? `${vitals.TTFB}ms` : '-', vitals.summary?.TTFB);
    setVital('fcpValue', 'fcpTag', vitals.FCP ? `${vitals.FCP}ms` : '-', null);
  }

  async loadConsoleLogs() {
    this.sendMessage({ type: 'get-console-logs' }, (response) => {
      const container = document.getElementById('consoleLogs');
      if (!container) return;

      if (!response || response.length === 0) {
        container.innerHTML = '<div class="log-item">暂无控制台输出</div>';
        return;
      }

      const logs = response.slice(-50).reverse();
      container.innerHTML = logs.map(log => `
        <div class="log-item ${log.type}">
          <span class="type">[${log.type.toUpperCase()}]</span>
          ${log.args.join(' ').slice(0, 200)}
        </div>
      `).join('');
    });
  }

  async loadNetworkLogs() {
    this.sendMessage({ type: 'get-network-logs' }, (response) => {
      const container = document.getElementById('networkLogs');
      const countEl = document.getElementById('networkCount');

      if (!container) return;

      if (!response || response.length === 0) {
        container.innerHTML = '<div class="log-item">暂无网络请求</div>';
        if (countEl) countEl.textContent = '0';
        return;
      }

      if (countEl) countEl.textContent = response.length;

      const logs = response.slice(-30).reverse();
      container.innerHTML = logs.map(log => `
        <div class="log-item network">
          <span class="type">[${log.method}]</span>
          ${log.url?.split('/').pop()?.split('?')[0] || log.url}
          ${log.statusCode ? `<span class="tag ${log.statusCode < 400 ? 'good' : 'error'}">${log.statusCode}</span>` : ''}
        </div>
      `).join('');
    });
  }

  // ============ 消息发送 ============

  sendMessage(message, callback) {
    chrome.runtime.sendMessage(message, (response) => {
      if (callback) callback(response);
    });
  }

  sendMessageAsync(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          reject(chrome.runtime.lastError);
        } else {
          resolve(response);
        }
      });
    });
  }
}

// 初始化
document.addEventListener('DOMContentLoaded', () => {
  new PopupController();
});
