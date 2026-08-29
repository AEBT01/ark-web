/**
 * Browser Debug Bridge — DevTools Panel Script
 */

const output = document.getElementById('output');

function log(data) {
  output.textContent = JSON.stringify(data, null, 2);
}

function sendToBackground(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      resolve(response);
    });
  });
}

document.getElementById('getDomBtn').addEventListener('click', async () => {
  output.textContent = '获取 DOM 中...';
  const result = await sendToBackground({ type: 'get-dom' });
  log(result);
});

document.getElementById('getPerfBtn').addEventListener('click', async () => {
  output.textContent = '分析性能中...';
  const result = await sendToBackground({ type: 'get-performance' });
  log(result);
});

document.getElementById('getVitalsBtn').addEventListener('click', async () => {
  output.textContent = '获取 Web Vitals 中...';
  const result = await sendToBackground({ type: 'get-web-vitals' });
  log(result);
});

document.getElementById('screenshotBtn').addEventListener('click', async () => {
  output.textContent = '截图中...';
  const result = await sendToBackground({ type: 'screenshot' });
  if (result?.dataUrl) {
    const a = document.createElement('a');
    a.href = result.dataUrl;
    a.download = `screenshot-${Date.now()}.png`;
    a.click();
    output.textContent = '截图已保存';
  } else {
    log(result);
  }
});

document.getElementById('getCookiesBtn').addEventListener('click', async () => {
  output.textContent = '获取 Cookies 中...';
  const result = await sendToBackground({ type: 'get-cookies' });
  log(result);
});

document.getElementById('a11yBtn').addEventListener('click', async () => {
  output.textContent = '检查可访问性中...';
  const result = await sendToBackground({ type: 'a11y-check' });
  log(result);
});

document.getElementById('seoBtn').addEventListener('click', async () => {
  output.textContent = '检查 SEO 中...';
  const result = await sendToBackground({ type: 'seo-check' });
  log(result);
});
