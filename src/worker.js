// 审计求解在 Web Worker 中运行，避免 BFS 阻塞页面主线程。
// type='audit'        —— 普通规范探测串审计；
// type='nonIntrusive' —— 非侵入辨识复核（终态要求映射恒等且回执两两不同）。
// seq 由主线程按模式分别递增并原样回传，用于丢弃输入变更后到达的陈旧响应。
import { audit, nonIntrusiveAudit, ValidationError } from './audit.js';

self.onmessage = e => {
  const data = e.data;
  if (!data) return;
  const seq = data.seq ?? 0;
  try {
    if (data.type === 'audit') {
      const result = audit(data.payload);
      self.postMessage({ type: 'result', result, seq, mode: 'audit' });
    } else if (data.type === 'nonIntrusive') {
      const result = nonIntrusiveAudit(data.payload);
      self.postMessage({ type: 'result', result, seq, mode: 'nonIntrusive' });
    }
  } catch (err) {
    if (err instanceof ValidationError) {
      self.postMessage({ type: 'error', messages: err.messages, seq, mode: data.type });
    } else {
      self.postMessage({ type: 'error', messages: [`内部错误：${err.message}`], seq, mode: data.type });
    }
  }
};
