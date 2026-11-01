// 冒烟测试：不启动 DSH，直接用假 ctx 把插件跑起来，验证工具能注册、能出图。
// 前置：先手动跑一个 bridge（python bridge.py --simulate --http 8765）
// 用法：node test/smoke.mjs

import { apply } from '../lib/index.js';

const tools = new Map();
const ctx = {
  logger: { info: console.log, warn: console.warn, error: console.error },
  tools: {
    register(t) {
      tools.set(t.name, t);
      return () => tools.delete(t.name);
    },
  },
  effect(fn) {
    return fn();
  },
};

apply(ctx, { python: 'python', httpPort: 8765, port: '', baud: 115200 });

console.log('注册到的工具：', [...tools.keys()].join(', '));

const status = await tools.get('autopid_status').execute({});
console.log('status =', JSON.stringify(status));

const stats = await tools.get('autopid_stats').execute({ window: 2 });
console.log('stats.points =', stats.points, 'channels =', stats.channels);

const plot = await tools.get('autopid_plot').execute({ window: 2 });
const bytes = Buffer.from(plot.png_base64, 'base64');
console.log('png bytes =', bytes.length, 'summary =', plot.summary);
if (bytes.length < 1000) throw new Error('图片太小，可能是空图');

// 验证 render 真的产出了 image 段
const rendered = tools.get('autopid_plot').output.render({}, plot);
const kinds = rendered.map((p) => p.type).join(',');
console.log('render 段 =', kinds);
if (!kinds.includes('image')) throw new Error('render 没有产出 image');

console.log('OK');
