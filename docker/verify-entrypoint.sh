#!/usr/bin/env bash
# verify 服务入口：依次执行 单元测试 → 构建检查 → HTTP 冒烟 → 浏览器端到端。
# 任一步失败立即以非零状态退出；全部通过输出 VERIFY_OK。
set -euo pipefail

cd /app

echo "== [1/4] 单元测试（node --test，区分模型 / 等价反例 / 非法输入核心逻辑） =="
npm run test:unit

echo "== [2/4] 构建检查（vite build） =="
npm run build

echo "== [3/4] HTTP 冒烟（健康检查与页面可达性，WEB_URL=${WEB_URL}） =="
# 等待 web 服务就绪（compose 已用健康检查把关，这里再做有限重试）
ready=0
for i in $(seq 1 30); do
  if node -e "fetch(process.env.WEB_URL+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then
    ready=1
    break
  fi
  sleep 1
done
if [ "$ready" -ne 1 ]; then
  echo "web 服务在超时内未通过健康检查" >&2
  exit 1
fi
npm run smoke

echo "== [4/4] 浏览器端到端（区分模型 / 等价反例 / 非法输入 的浏览器操作） =="
npx playwright test

echo ""
echo "VERIFY_OK：单元测试、构建检查、HTTP 冒烟、浏览器端到端全部通过。"
