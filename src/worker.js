// 审计求解在 Web Worker 中运行，避免 BFS 阻塞页面主线程。
import { audit, ValidationError } from './audit.js';

self.onmessage = e => {
  if (!e.data || e.data.type !== 'audit') return;
  try {
    const result = audit(e.data.payload);
    self.postMessage({ type: 'result', result });
  } catch (err) {
    if (err instanceof ValidationError) {
      self.postMessage({ type: 'error', messages: err.messages });
    } else {
      self.postMessage({ type: 'error', messages: [`内部错误：${err.message}`] });
    }
  }
};
