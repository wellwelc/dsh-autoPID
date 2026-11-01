// 冒烟测试：不启动 DSH，直接用假 ctx 把插件跑起来，验证工具能注册、能出图。
//
// 两种跑法：
//   node test/smoke.mjs                     # 插件自己拉起 bridge（不连串口，空数据）
//   node test/smoke.mjs --simulate          # 用 bridge 的假数据源，能画出真波形
//
// 结束时会把 bridge 子进程收掉，不然 Node 会被它挂住退不出来。

import fs from 'node:fs';
import { apply } from '../lib/index.js';

const simulate = process.argv.includes('--simulate');

const tools = new Map();
let dispose = null;

const ctx = {
  logger: { info: console.log, warn: console.warn, error: console.error },
  tools: {
    register(t) {
      tools.set(t.name, t);
      return () => tools.delete(t.name);
    },
  },
  effect(fn) {
    dispose = fn();
    return dispose;
  },
};

// 想用假数据时，先把一个 simulate 的 bridge 手动跑起来：
//   python bridge/bridge.py --simulate --http 8765
// 插件发现端口活着就直接复用，不会另起一个。
apply(ctx, {
  python: 'python',
  httpPort: 8765,
  port: '',
  baud: 115200,
});

try {
  console.log('注册到的工具：', [...tools.keys()].join(', '));

  const status = await tools.get('autopid_status').execute({});
  console.log('status.connected =', status.connected, '| channels =', status.channels);

  const stats = await tools.get('autopid_stats').execute({ window: 2 });
  console.log('stats.points =', stats.points, '| channels =', stats.channels);

  const plot = await tools.get('autopid_plot').execute({ window: 2 });
  const bytes = fs.readFileSync(plot.png_path);
  console.log('png 落盘 =', plot.png_path, '| bytes =', bytes.length);
  if (bytes.length < 1000) throw new Error('图片太小，可能是空图');

  const rendered = tools.get('autopid_plot').output.render({}, plot);
  const kinds = rendered.map((p) => p.type).join(',');
  console.log('render 段 =', kinds);
  // 2026-11-01：render 里绝不能出现 image（会让会话永久失败），只允许 text
  if (kinds.includes('image')) throw new Error('render 里出现了 image 段 —— 会毒死会话');
  if (!kinds.includes('text')) throw new Error('render 没有产出 text');

  console.log('OK');
} finally {
  // 把插件拉起来的 bridge 收掉
  try {
    dispose?.();
  } catch (e) {
    console.warn('cleanup:', e.message);
  }
  // 子进程即使 kill 了也可能有一两帧的收尾，稍等一下再退
  setTimeout(() => process.exit(0), 300);
}
