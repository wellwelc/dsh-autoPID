// dsh-autoPID —— 串口波形图 + PID 调参工具
//
// 分工：
//   bridge/bridge.py  （Python + pyserial）负责真正的串口读写、缓冲、画图
//   本文件            （Node）负责把 bridge 拉起来，并把它的 HTTP 接口包成工具
//
// 为什么串口不在 Node 里读：DSH 跑在 Electron 里，`serialport` 是原生模块，
// 要按 Electron 的 ABI 重新编译，换个 DSH 版本就可能挂；pyserial 是纯 Python，
// 装一次就完事。代价是用户机器上得有 Python，这一点在 apply 时会给出提示。

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = 'dsh-autopid';

// 必须显式声明依赖的服务。不写这行，ctx.tools 就是 undefined，
// ctx.tools.register() 会抛 TypeError —— 而它被我下面的 try/catch 吞掉，
// 表现出来就是"插件装好了但一个工具都没有"（2026-11-01 踩过）。
export const inject = ['tools'];

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BRIDGE_PY = path.join(ROOT, 'bridge', 'bridge.py');

/** 当前托管的 bridge 子进程（null = 还没起或已退出）。 */
let child = null;
/** 实际使用的 HTTP 端口，跟着 config 走。 */
let httpPort = 8765;
let logger = console;

// schemastery 只在 DSH 里才有；独立跑冒烟测试时拿不到，就让 Config 留空，
// 工具照常工作（只是设置页里没有这个插件的表单）。
let Config;
try {
  const mod = await import('@deepseek-ai/schemastery');
  const z = mod.default ?? mod;
  Config = z.object({
    python: z.string().default('python').description('Python 解释器（PATH 里的名字或绝对路径）'),
    httpPort: z.natural().default(8765).description('bridge 的本地 HTTP 端口'),
    port: z.string().default('').description('串口名，如 COM3；留空表示只起桥不开串口'),
    baud: z.natural().default(115200).description('波特率'),
  });
} catch {
  Config = undefined;
}
export { Config };

// ------------------------------------------------------------------ bridge 通讯

function base() {
  return `http://127.0.0.1:${httpPort}`;
}

async function api(pathAndQuery, init) {
  const res = await fetch(base() + pathAndQuery, {
    ...init,
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    throw new Error(`bridge ${pathAndQuery} -> HTTP ${res.status}`);
  }
  return res;
}

async function apiJson(pathAndQuery, init) {
  const res = await api(pathAndQuery, init);
  return res.json();
}

async function alive() {
  try {
    await api('/status');
    return true;
  } catch {
    return false;
  }
}

/** 把 bridge 拉起来。已经在跑就直接复用。 */
async function ensureBridge(config) {
  if (await alive()) return { reused: true };

  if (!fs.existsSync(BRIDGE_PY)) {
    throw new Error(`找不到 bridge 脚本：${BRIDGE_PY}`);
  }

  const args = [BRIDGE_PY, '--http', String(httpPort)];
  if (config.port) {
    args.push('--port', config.port, '--baud', String(config.baud || 115200));
  } else if (config.simulate) {
    args.push('--simulate');
  }

  child = spawn(config.python || 'python', args, {
    cwd: path.join(ROOT, 'bridge'),
    stdio: 'ignore',
    windowsHide: true,
    detached: false,
  });
  child.on('exit', (code) => {
    logger.warn?.(`dsh-autopid: bridge exited (code=${code})`);
    child = null;
  });
  child.on('error', (err) => {
    logger.error?.(`dsh-autopid: bridge spawn failed: ${err.message}`);
    child = null;
  });

  // 等它把 HTTP 端口监听起来（最多 6 秒）
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    if (await alive()) return { reused: false, pid: child?.pid };
  }
  throw new Error('bridge 启动超时：6 秒内没连上 HTTP 端口');
}

// ------------------------------------------------------------------ 工具

function toolStatus() {
  return {
    name: 'autopid_status',
    description:
      '查看串口桥的状态：是否连着、串口名、已收到多少行、缓冲里有多少点、几个通道、数据有多旧。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          connected: { type: 'boolean' },
          port: { type: 'string' },
          lines: { type: 'number' },
          buffer: { type: 'number' },
          channels: { type: 'number' },
        },
      },
      render: (_a, v) => [{ type: 'text', text: fmtStatus(v) }],
    },
    async execute() {
      await ensureBridge(cfg());
      const st = await apiJson('/status');
      return st;
    },
  };
}

function fmtStatus(st) {
  if (!st || typeof st !== 'object') return '拿不到状态。';
  const lines = [];
  lines.push(st.connected ? `串口已连接：${st.port ?? '?'} @ ${st.baud ?? '?'}` : `串口未连接${st.last_error ? `（${st.last_error}）` : ''}`);
  lines.push(`累计 ${st.lines ?? 0} 行（坏行 ${st.bad_lines ?? 0}），缓冲 ${st.buffer ?? 0} 点，${st.channels ?? 0} 个通道`);
  if (st.newest_age != null) lines.push(`最新数据 ${st.newest_age}s 前，最老 ${st.oldest_age}s 前`);
  if (st.last_line) lines.push(`最后一行：${st.last_line}`);
  return lines.join('\n');
}

function toolStats() {
  return {
    name: 'autopid_stats',
    description:
      '统计缓冲里某段时间的波形特征：每通道的最小/最大/均值/有效值/峰峰值，以及由过均值次数估出的振荡频率。' +
      '调参时先用它看哪一段在振、振多少，再决定画哪一段。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        window: { type: 'number', description: '只看最近多少秒；不传就是整个缓冲' },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: fmtStats(v) }],
    },
    async execute(args) {
      await ensureBridge(cfg());
      const q = args?.window ? `?window=${Number(args.window)}` : '';
      return await apiJson('/stats' + q);
    },
  };
}

function fmtStats(st) {
  if (!st?.per_channel?.length) return '没有数据。先确认串口在发东西（autopid_status）。';
  const out = [`${st.points} 点 / ${st.duration}s / ${st.channels} 通道`];
  st.per_channel.forEach((c, i) => {
    if (!c) return;
    out.push(
      `CH${i}: min ${c.min} max ${c.max} mean ${c.mean} rms ${c.rms} 峰峰 ${c.pp} 振荡≈${c.freq_hz}Hz`,
    );
  });
  out.push('提示：峰峰值大 + 振荡频率高 = 在振；用 autopid_plot 指定 start/end 把那段画出来看。');
  return out.join('\n');
}

function toolPlot() {
  return {
    name: 'autopid_plot',
    description:
      '把串口缓冲里的数据画成波形图，图片直接显示在对话里。' +
      '不给时间参数就画整个缓冲；给 window 画最近 N 秒；给 start/end 画那一段（用 autopid_stats 返回的 t0/t1 或 /samples 的时间戳）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        window: { type: 'number', description: '最近多少秒' },
        start: { type: 'number', description: '起始时间戳（秒，Unix 时间）' },
        end: { type: 'number', description: '结束时间戳（秒，Unix 时间）' },
        channels: {
          type: 'array',
          items: { type: 'number' },
          description: '只画这几路，比如 [0,1]；不传画全部',
        },
        normalize: {
          type: 'boolean',
          description: '每通道各自归一化到 0~1，量级差很多时用',
        },
        title: { type: 'string', description: '图上的标题' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          png_base64: { type: 'string' },
          summary: { type: 'string' },
        },
      },
      render: (_a, v) => {
        if (!v?.png_base64) return [{ type: 'text', text: v?.error ?? '出图失败。' }];
        const parts = [{ type: 'image', data: v.png_base64, mimeType: 'image/png' }];
        if (v.summary) parts.push({ type: 'text', text: v.summary });
        return parts;
      },
    },
    async execute(args) {
      await ensureBridge(cfg());
      const qs = new URLSearchParams();
      if (args?.window != null) qs.set('window', String(args.window));
      if (args?.start != null) qs.set('start', String(args.start));
      if (args?.end != null) qs.set('end', String(args.end));
      if (Array.isArray(args?.channels) && args.channels.length) {
        qs.set('ch', args.channels.join(','));
      }
      if (args?.normalize) qs.set('norm', '1');
      if (args?.title) qs.set('title', String(args.title));

      const res = await api('/plot?' + qs.toString());
      const buf = Buffer.from(await res.arrayBuffer());
      const st = await apiJson('/status').catch(() => null);
      return {
        png_base64: buf.toString('base64'),
        summary: st
          ? `${st.channels ?? '?'} 通道，缓冲 ${st.buffer ?? 0} 点${st.newest_age != null ? `，最新数据 ${st.newest_age}s 前` : ''}`
          : '已出图',
      };
    },
  };
}

function toolSet() {
  return {
    name: 'autopid_set',
    description:
      '把一组参数下发到单片机。默认按 "SET v1 v2 v3\\n" 的文本格式发；单片机那边需要自己实现接收解析。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['values'],
      properties: {
        values: {
          type: 'array',
          items: { type: 'number' },
          description: '要下发的数字，比如 [1.2, 0.03, 0.3] 表示 kp ki kd',
        },
        raw: {
          type: 'string',
          description: '给这个就直接发原文（\n 会补上），忽略 values',
        },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [
        { type: 'text', text: v?.ok ? `已发送：${v.sent}` : `发送失败：${v?.error ?? '未知原因'}` },
      ],
    },
    async execute(args) {
      await ensureBridge(cfg());
      if (args?.raw) {
        return await apiJson('/raw', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: String(args.raw) }),
        });
      }
      return await apiJson('/set', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: args?.values ?? [] }),
      });
    },
  };
}

function toolPorts() {
  return {
    name: 'autopid_ports',
    description: '列出本机所有串口（名字 + 描述），用来确认单片机插在哪个口。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => {
        const list = v?.ports ?? [];
        if (!list.length) return [{ type: 'text', text: '一个串口都没找到。' }];
        return [
          {
            type: 'text',
            text: list.map((p) => `${p.device}  ${p.desc ?? ''}`).join('\n'),
          },
        ];
      },
    },
    async execute() {
      await ensureBridge(cfg());
      return await apiJson('/ports');
    },
  };
}

// ------------------------------------------------------------------ 装配

let currentConfig = { python: 'python', httpPort: 8765, port: '', baud: 115200 };

function cfg() {
  return currentConfig;
}

export function apply(ctx, config = {}) {
  if (ctx?.logger) logger = ctx.logger;
  currentConfig = {
    python: config.python ?? 'python',
    httpPort: Number(config.httpPort ?? 8765),
    port: config.port ?? '',
    baud: Number(config.baud ?? 115200),
  };
  httpPort = currentConfig.httpPort;

  logger.info?.(
    `dsh-autopid: ready (python=${currentConfig.python}, http=${httpPort}, port=${currentConfig.port || '(none)'})`,
  );

  const disposers = [];
  for (const make of [toolPorts, toolStatus, toolStats, toolPlot, toolSet]) {
    try {
      const dispose = ctx.tools.register(make());
      if (typeof dispose === 'function') disposers.push(dispose);
    } catch (err) {
      logger.error?.(`dsh-autopid: register ${make.name} failed: ${err.message}`);
    }
  }

  // 卸载时把子进程收掉，别留孤儿占用串口
  ctx.effect?.(() => () => {
    for (const d of disposers) {
      try {
        d();
      } catch {}
    }
    if (child) {
      try {
        child.kill();
      } catch {}
      child = null;
    }
  });
}
