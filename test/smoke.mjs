// HTTP 冒烟：健康检查 + 首页 + 构建产物可达。失败以非零码退出。
const base = process.env.WEB_URL || 'http://localhost:8080';

async function check(pathname, { json = false, mustContain = null } = {}) {
  const url = base.replace(/\/$/, '') + pathname;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  const body = await res.text();
  if (mustContain && !body.includes(mustContain)) {
    throw new Error(`GET ${url} 响应中未找到期望内容：${mustContain}`);
  }
  return { url, body, json: json ? JSON.parse(body) : null };
}

try {
  const h = await check('/healthz', { json: true });
  if (h.json.status !== 'ok') throw new Error(`healthz 负载异常：${h.body}`);
  console.log('✓ /healthz 200', h.body);

  const idx = await check('/', { mustContain: '规范探测串' });
  console.log('✓ / 200，首页包含标题');

  const asset = idx.body.match(/src="(\/assets\/[^"]+\.js)"/);
  if (!asset) throw new Error('首页未引用构建后的 JS 资源');
  await check(asset[1], { mustContain: null });
  console.log('✓ 构建产物', asset[1], '200');

  const css = idx.body.match(/href="(\/assets\/[^"]+\.css)"/);
  if (css) {
    await check(css[1]);
    console.log('✓ 样式产物', css[1], '200');
  }

  console.log('SMOKE_OK');
} catch (err) {
  console.error('SMOKE_FAIL:', err.message);
  process.exit(1);
}
