// 审计求解在 Web Worker 中运行，避免 BFS 阻塞页面主线程。
import { audit, nonIntrusiveReview, ValidationError } from './audit.js';

self.onmessage = e => {
  const data = e.data;
  if (!data) return;
  try {
    if (data.type === 'audit') {
      const result = audit(data.payload);
      self.postMessage({ type: 'result', result });
      return;
    }
    if (data.type === 'nonIntrusiveReview') {
      // 与普通审计并列的非侵入辨识复核；普通结论由主线程保留，不受影响。
      const result = nonIntrusiveReview(data.payload);
      self.postMessage({ type: 'niResult', result });
      return;
    }
  } catch (err) {
    if (err instanceof ValidationError) {
      if (data.type === 'nonIntrusiveReview') {
        self.postMessage({ type: 'niError', messages: err.messages });
      } else {
        self.postMessage({ type: 'error', messages: err.messages });
      }
    } else {
      const msg = `内部错误：${err.message}`;
      self.postMessage(
        data.type === 'nonIntrusiveReview'
          ? { type: 'niError', messages: [msg] }
          : { type: 'error', messages: [msg] },
      );
    }
  }
};
