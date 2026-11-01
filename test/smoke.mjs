// 冒烟测试：不启动 DSH，直接用假 ctx 把插件跑起来，验证工具能注册、能读数据、能出图。
//
// 跑法：node test/smoke.mjs
//   自己起一个模拟数据的 bridge（--simulate），所以不插板子也有数据；
//   结束时把它收掉，不然 Node 会被子进程挂住退不出来。

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 用临时 DSH_HOME，别把测试写进真实的设置文件
process.env.DSH_HOME = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'out', 'test-dsh-smoke');
fs.rmSync(process.env.DSH_HOME, { recursive: true, force: true });

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
  const csvPath = path.join(ROOT, 'out', 'smoke-data.csv');
  try {
    fs.rmSync(csvPath, { force: true });
  } catch {}
  apply(ctx, {
    python: 'python',
    httpPort: PORT,
    port: '',
    baud: 115200,
    csvPath,
    channels: 2,
    channelNames: '左,右',
    paramNames: 'kp,ki,kd',
    setFormat: 'named',
    cmdStart: 'GO',
    cmdStop: 'HALT',
    cmdReset: 'RST',
  });

  console.log('注册到的工具：', [...tools.keys()].join(', '));
  for (const name of ['autopid_samples', 'autopid_set', 'autopid_command']) {
    if (!tools.has(name)) fail(`少了工具 ${name}`);
  }

  // 第一次调用工具时才会把配置同步给桥（CSV 从那之后才开始写），
  // 所以先碰一下 status，再等数据攒起来。
  const status = await tools.get('autopid_status').execute({});
  console.log('status.connected =', status.connected, '| buffer =', status.buffer, '| channels =', status.channels);

  await sleep(1500); // 等模拟数据写进 CSV

  const stats = await tools.get('autopid_stats').execute({ window: 2 });
  console.log('stats.points =', stats.points, '| channels =', stats.channels);

  // 读的是落盘的 CSV（有配置时）
  const samples = await tools.get('autopid_samples').execute({ window: 60, limit: 20 });
  console.log('samples.rows =', samples.rows.length, '| source =', samples.source, '| names =', JSON.stringify(samples.names));
  if (samples.source !== 'csv') fail(`应该读 CSV，实际是 ${samples.source}`);
  if (!fs.existsSync(csvPath)) fail('CSV 文件没生成');
  if (!samples.rows.length) fail('samples 一个点都没读到');
  if ((samples.names ?? []).length !== 2) fail(`按配置应该是 2 路，实际 ${JSON.stringify(samples.names)}`);
  const widths = new Set(samples.rows.map((r) => r.length));
  if (widths.size !== 1) fail(`samples 行的列数不一致：${[...widths].join(' / ')}`);
  const rowTypes = samples.rows.every((r) => r.every((x) => typeof x === 'number'));
  if (!rowTypes) fail('samples 里出现了非数字');

  // 按通道挑选也要能用
  const picked = await tools.get('autopid_samples').execute({ window: 60, limit: 5, channels: [0] });
  if (picked.rows.some((r) => r.length !== 2)) fail('channels 筛选后行宽应为 时间戳+1 列');
  console.log('samples 指定通道 =', JSON.stringify(picked.rows[0]));

  // 没有表头、还带 UTF-8 BOM 的 CSV 也要能读（PowerShell 导出的文件常长这样）
  const noHeader = path.join(ROOT, 'out', 'smoke-nohdr.csv');
  fs.writeFileSync(noHeader, '\ufeff0.1,1.5,2.5\n0.2,1.6,2.6\n0.3,1.7,2.7\n', 'utf8');
  const noHdr = await tools.get('autopid_samples').execute({ file: noHeader, limit: 10 });
  if (noHdr.rows.length !== 3) fail(`无表头 CSV 应该读出 3 行，实际 ${noHdr.rows.length}`);
  if (noHdr.rows[0][0] !== 0.1) fail(`BOM 没去掉：第一格是 ${noHdr.rows[0][0]}`);
  console.log('无表头 CSV =', JSON.stringify(noHdr.rows));

  // 参数下发：命名格式要能拼出来（模拟数据没有真串口，所以验证它老实说"没发出去"）
  const sent = await tools.get('autopid_set').execute({ values: [1.2, 0.03, 0.3], waitMs: 100 });
  const setText = tools.get('autopid_set').output.render({}, sent)[0].text;
  console.log('set 回执 =', setText.replace(/\n/g, ' / '));
  if (sent.ok) fail('模拟数据模式下 set 不该报成功');

  // 启动 / 停止 / 重来：正文来自配置
  const started = await tools.get('autopid_command').execute({ action: 'start', waitMs: 0 });
  console.log('command.start =', started.ok, '| error =', started.error);
  if (started.ok) fail('没开串口时 command 不该报成功');
  const cmdCfg = await (await fetch(`${BASE}/config`)).json();
  console.log('cmd 配置 =', cmdCfg.cmd_start, '/', cmdCfg.cmd_stop, '/', cmdCfg.cmd_reset);
  if (cmdCfg.cmd_start !== 'GO' || cmdCfg.cmd_reset !== 'RST') fail('指令正文没同步到桥');
  if (cmdCfg.set_format !== 'named') fail('set_format 没同步到桥');

  // 图形化配置对应的工具：读得到、改得动、写盘
  const cfgTool = await tools.get('autopid_config').execute({});
  if (cfgTool.config?.paramNames !== 'kp,ki,kd') fail(`autopid_config 读到的参数名不对：${cfgTool.config?.paramNames}`);
  const patched = await tools.get('autopid_config').execute({ patch: { setFormat: 'positional' } });
  if (patched.config?.setFormat !== 'positional') fail('autopid_config 改 setFormat 没生效');
  if (!fs.existsSync(patched.file)) fail('autopid_config 没把设置写进磁盘');
  console.log('autopid_config 写盘 =', patched.file);

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
