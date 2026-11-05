const srv = document.getElementById('srv');
const ext = document.getElementById('ext');
const ver = document.getElementById('ver');

ver.textContent = chrome.runtime.getManifest().version;

fetch('http://127.0.0.1:9333/health')
  .then((r) => r.json())
  .then((j) => {
    srv.textContent = `在线 :${9333}`;
    srv.className = 'ok';
    const n = j.extensions ?? 0;
    ext.textContent = n > 0 ? `已连接（${n}）` : '未连接';
    ext.className = n > 0 ? 'ok' : 'off';
  })
  .catch(() => {
    srv.textContent = '未启动';
    srv.className = 'off';
    ext.textContent = '—';
  });
