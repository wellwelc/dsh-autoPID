// 冒烟测试：不启动 DSH，直接用假 ctx 把插件跑起来，验证工具能注册、能读数据、能出图。
//
// 跑法：node test/smoke.mjs
//   自己起一个模拟数据的 bridge（--simulate），所以不插板子也有数据；
//   结束时把它收掉，不然 Node 会被子进程挂住退不出来。

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8767;
const BASE = `http://127.0.0.1:${PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function alive() {
  try {
    const res = await fetch(`${BASE}/status`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

const bridge = spawn('python', [path.join(ROOT, 'bridge', 'bridge.py'), '--simulate', '--http', String(PORT)], {
  cwd: path.join(ROOT, 'bridge'),
  stdio: 'ignore',
  windowsHide: true,
});

let dispose = null;
let failed = false;
const fail = (msg) => {
  failed = true;
  console.error('FAIL', msg);
};

try {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && !(await alive())) await sleep(200);
  if (!(await alive())) throw new Error('模拟 bridge 没起来');

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
      dispose = fn();
      return dispose;
    },
  };

  // 插件发现端口活着就直接复用，不会另起一个 bridge
  const { apply } = await import('../lib/index.js');
  apply(ctx, { python: 'python', httpPort: PORT, port: '', baud: 115200 });

  console.log('注册到的工具：', [...tools.keys()].join(', '));
  for (const name of ['autopid_samples', 'autopid_set']) {
    if (!tools.has(name)) fail(`少了工具 ${name}`);
  }

  await sleep(1200); // 等模拟数据攒一点

  const status = await tools.get('autopid_status').execute({});
  console.log('status.connected =', status.connected, '| buffer =', status.buffer, '| channels =', status.channels);

  const stats = await tools.get('autopid_stats').execute({ window: 2 });
  console.log('stats.points =', stats.points, '| channels =', stats.channels);

  // 新工具：读原始数据
  const samples = await tools.get('autopid_samples').execute({ window: 2, limit: 20 });
  console.log('samples.rows =', samples.rows.length, '| t0 =', samples.t0, '| total =', samples.total);
  if (!samples.rows.length) fail('samples 一个点都没读到');
  const widths = new Set(samples.rows.map((r) => r.length));
  if (widths.size !== 1) fail(`samples 行的列数不一致：${[...widths].join(' / ')}`);
  const rowTypes = samples.rows.every((r) => r.every((x) => typeof x === 'number'));
  if (!rowTypes) fail('samples 里出现了非数字');

  // 按通道挑选也要能用
  const picked = await tools.get('autopid_samples').execute({ window: 2, limit: 5, channels: [0] });
  if (picked.rows.some((r) => r.length !== 2)) fail('channels 筛选后行宽应为 时间戳+1 列');
  console.log('samples 指定通道 =', JSON.stringify(picked.rows[0]));

  // 新工具：改参数（模拟数据时没有真串口，这里验证它老实说"没发出去"）
  const sent = await tools.get('autopid_set').execute({ values: [1.2, 0.03, 0.3], waitMs: 100 });
  const setText = tools.get('autopid_set').output.render({}, sent)[0].text;
  console.log('set 回执 =', setText.replace(/\n/g, ' / '));
  if (sent.ok) fail('模拟数据模式下 set 不该报成功');

  const plot = await tools.get('autopid_plot').execute({ window: 2 });
  const bytes = fs.readFileSync(plot.png_path);
  console.log('png 落盘 =', plot.png_path, '| bytes =', bytes.length);
  if (bytes.length < 1000) fail('图片太小，可能是空图');

  const rendered = tools.get('autopid_plot').output.render({}, plot);
  const kinds = rendered.map((p) => p.type).join(',');
  console.log('render 段 =', kinds);
  // 2026-11-01：render 里绝不能出现 image（会让会话永久失败），只允许 text
  if (kinds.includes('image')) fail('render 里出现了 image 段 —— 会毒死会话');
  if (!kinds.includes('text')) fail('render 没有产出 text');
  console.log(failed ? '有失败项' : 'OK');
} catch (error) {
  failed = true;
  console.error('TEST ERROR', error);
} finally {
  try {
    dispose?.();
  } catch (e) {
    console.warn('cleanup:', e.message);
  }
  try {
    bridge.kill();
  } catch {}
  setTimeout(() => process.exit(failed ? 1 : 0), 300);
}
