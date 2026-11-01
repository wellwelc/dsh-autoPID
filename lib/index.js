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
//
// webServer 是给设置页那块面板用的（/api/autopid/* 同源路由）。
// 只有 web 侧的 composition 才有这个服务；纯 headless 的 profile 里没有它，
// 插件会一直等着不激活 —— 所以别把本插件装进 headless profile。
export const inject = ['tools', 'webServer'];

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
      '把串口缓冲里的数据画成波形图，PNG 存到 dsh-autoPID/out/ 并返回文件路径（不内联显示：内联图片会毒死会话）。' +
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
          png_path: { type: 'string' },
          summary: { type: 'string' },
        },
      },
      // ⚠️ 千万别在这里返回 { type: 'image' }。
      // 2026-11-01 实测：工具结果里的图片内容块会让**之后每一次**请求在拼装阶段
      // 直接失败（`DeepSeek Messages transport failed` / TRANSPORT，20 毫秒内），
      // 而且图永远留在会话历史里 → 整个对话永久作废（8 KB 的小图都能触发）。
      // 所以只回文字 + 落盘路径，人自己打开看。
      render: (_a, v) => {
        const lines = [];
        if (v?.summary) lines.push(v.summary);
        if (v?.png_path) lines.push(`图已存到：${v.png_path}（直接打开看；这里不内联显示，内联会毒死会话）`);
        if (!lines.length) lines.push(v?.error ?? '出图失败。');
        return [{ type: 'text', text: lines.join('\n') }];
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
      // 落盘，只把路径交回去（原因见上面 output.render 的注释）
      const outDir = path.join(ROOT, 'out');
      try { fs.mkdirSync(outDir, { recursive: true }); } catch {}
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const pngPath = path.join(outDir, `plot-${stamp}.png`);
      try { fs.writeFileSync(pngPath, buf); } catch {}
      const st = await apiJson('/status').catch(() => null);
      return {
        png_path: pngPath,
        summary: st
          ? `${st.channels ?? '?'} 通道，缓冲 ${st.buffer ?? 0} 点${st.newest_age != null ? `，最新数据 ${st.newest_age}s 前` : ''}`
          : '已出图',
      };
    },
  };
}

// ---------------------------------------------------------------- 给模型读数据的工具

function fmtSamples(v) {
  if (!v?.rows?.length) {
    return '这段时间里没有数据。先 autopid_status 看看串口通不通、有没有新行。';
  }
  const head = `起点 t0=${v.t0}，共 ${v.rows.length} 点${v.channels ? `，${v.channels.length} 通道` : ''}`;
  const lines = v.rows.map((row) => {
    const [t, ...vals] = row;
    return [String(t).padStart(12), ...vals.map((x) => String(x).padStart(12))].join(' ');
  });
  const more = v.truncated ? [`……还有 ${v.total - v.rows.length} 点没给，要更细就加 limit 或缩小窗口`] : [];
  return [head, ...lines, ...more].join('\n');
}

function toolSamples() {
  return {
    name: 'autopid_samples',
    description:
      '读串口缓冲里的原始采样点：每个点的时间戳和各通道数值，一行一个点。' +
      '想看波形具体长什么样、想自己算超调/上升时间/稳态误差时用它；只要统计特征（min/max/峰峰/振荡频率）用 autopid_stats 更快。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        window: { type: 'number', description: '只看最近多少秒' },
        start: { type: 'number', description: '起始时间戳（秒，Unix）；和 end 配对使用' },
        end: { type: 'number', description: '结束时间戳（秒，Unix）' },
        limit: {
          type: 'number',
          description: '最多给多少个点（超了会均匀抽稀），默认 80，最多 2000',
        },
        channels: {
          type: 'array',
          items: { type: 'number' },
          description: '只看这几路，比如 [0,1]；不传就是全部',
        },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: fmtSamples(v) }],
    },
    async execute(args) {
      await ensureBridge(cfg());
      const qs = new URLSearchParams();
      const limit = Math.min(2000, Math.max(1, Number(args?.limit ?? 80)));
      qs.set('limit', String(limit));
      if (args?.window != null) {
        const end_t = Date.now() / 1000;
        qs.set('start', String(end_t - Number(args.window)));
        qs.set('end', String(end_t));
      } else {
        if (args?.start != null) qs.set('start', String(args.start));
        if (args?.end != null) qs.set('end', String(args.end));
      }
      if (Array.isArray(args?.channels) && args.channels.length) {
        qs.set('ch', args.channels.join(','));
      }
      const raw = await apiJson('/samples?' + qs.toString());
      return {
        t0: raw?.t0 ?? null,
        rows: raw?.rows ?? [],
        channels: Array.isArray(args?.channels) && args.channels.length ? args.channels : null,
        total: raw?.total ?? raw?.rows?.length ?? 0,
        truncated: Boolean(raw?.truncated),
      };
    },
  };
}

function toolSet() {
  return {
    name: 'autopid_set',
    description:
      '把一组参数下发到单片机，并回报"发完之后有没有新数据进来"，用来看单片机到底有没有反应。' +
      '默认按 "SET v1 v2 v3\\n" 的文本格式发（单片机那边要自己实现接收解析）；给 raw 就直接发原文。',
    parameters: {
      type: 'object',
      additionalProperties: false,
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
        waitMs: {
          type: 'number',
          description: '发完之后等多久再看有没有新数据，默认 400 毫秒；单片机回得慢就调大',
        },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => {
        const err = String(v?.error ?? '');
        const noSerial = err.includes('serial not open');
        if (!v?.ok) {
          return [{
            type: 'text',
            text: noSerial
              ? '没发出去：串口没开着。先用 autopid_open 打开串口（或者 autopid_ports 看有没有口），再下发参数。'
              : `发送失败：${err || '未知原因'}`,
          }];
        }
        const lines = [`已发送：${v.sent}`];
        if (v.new_lines === null) {
          lines.push('发完没能读到状态，单片机有没有反应看不出来。');
        } else if (v.new_lines > 0) {
          lines.push(`发完之后 ${v.waited_ms} 毫秒里新来了 ${v.new_lines} 行，单片机在发数据。最后一行：${v.last_line || '(空)'}`);
        } else {
          lines.push(`发完之后 ${v.waited_ms} 毫秒里一行新数据都没有 —— 单片机没回话，或者它本来就不输出。这一条只是"没观察到"，不等于"参数没生效"。`);
        }
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(args) {
      await ensureBridge(cfg());
      // 下发前先记一个水位，发完再看涨没涨 —— 这是"单片机有没有反应"唯一硬的证据
      const before = await apiJson('/status').catch(() => null);
      const res = args?.raw
        ? await apiJson('/raw', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: String(args.raw) }),
        })
        : await apiJson('/set', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ values: args?.values ?? [] }),
        });

      const waitMs = Math.min(5000, Math.max(0, Number(args?.waitMs ?? 400)));
      if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
      const after = await apiJson('/status').catch(() => null);

      const beforeLines = typeof before?.lines === 'number' ? before.lines : null;
      const afterLines = typeof after?.lines === 'number' ? after.lines : null;
      return {
        ...res,
        waited_ms: waitMs,
        waiting_on_serial: String(res?.error ?? '').includes('serial not open'),
        lines_before: beforeLines,
        lines_after: afterLines,
        new_lines: beforeLines !== null && afterLines !== null ? afterLines - beforeLines : null,
        last_line: after?.last_line ?? null,
      };
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

function toolOpen() {
  return {
    name: 'autopid_open',
    description:
      '打开或切换串口，不用重启 DSH。给 port 就开真串口（换口也用它）；给 simulate=true 就切到假数据，没硬件时验证出图；给 close=true 就关掉当前串口。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        port: { type: 'string', description: '串口名，如 COM3' },
        baud: { type: 'number', description: '波特率，默认 115200' },
        simulate: { type: 'boolean', description: '切到模拟数据（没硬件时自测）' },
        close: { type: 'boolean', description: '关掉当前串口' },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [
        {
          type: 'text',
          text: v?.ok
            ? `已切换：${v.mode ?? (v.port ? `${v.port} @ ${v.baud}` : '关闭')}`
            : `没切成：${v?.error ?? '未知原因'}`,
        },
      ],
    },
    async execute(args) {
      await ensureBridge(cfg());
      if (args?.close) {
        return await apiJson('/close', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
      }
      if (args?.simulate) {
        return await apiJson('/open', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ simulate: true }),
        });
      }
      if (!args?.port) throw new Error('要给 port，或者 simulate=true，或者 close=true');
      return await apiJson('/open', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ port: String(args.port), baud: Number(args.baud ?? 115200) }),
      });
    },
  };
}

// ------------------------------------------------------------------ Web 页面用的同源路由
//
// 设置页里的「自动调参」面板（client.js）不直连桥的端口，而是走这几个路由：
// 端口是配置项、随时可能改，页面只认 /api/autopid/*，换端口页面不用动。
// 全部只允许本机访问 —— 这是调硬件的口子，不该被局域网里别人碰到。

const ROUTE_PREFIX = '/api/autopid';

function sendJson(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  });
  res.end(body);
}

function isLoopback(req) {
  const ip = req?.socket?.remoteAddress ?? '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(data === '' ? {} : JSON.parse(data));
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}

async function handleRoute(req, res) {
  if (!isLoopback(req)) {
    sendJson(res, 403, { ok: false, error: '只允许本机访问' });
    return;
  }
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const path = url.pathname;

  try {
    if (path === `${ROUTE_PREFIX}/state` && req.method === 'GET') {
      await ensureBridge(cfg());
      sendJson(res, 200, { ok: true, status: await apiJson('/status') });
      return;
    }

    if (path === `${ROUTE_PREFIX}/ports` && req.method === 'GET') {
      await ensureBridge(cfg());
      sendJson(res, 200, { ok: true, ...(await apiJson('/ports')) });
      return;
    }

    if (path === `${ROUTE_PREFIX}/plot.png` && req.method === 'GET') {
      await ensureBridge(cfg());
      // 只转发桥认的这几个参数，别把页面上的 t= 之类丢过去
      const pass = new URLSearchParams();
      for (const key of ['window', 'start', 'end', 'ch', 'norm', 'title', 'width', 'height']) {
        const v = url.searchParams.get(key);
        if (v !== null && v !== '') pass.set(key, v);
      }
      const upstream = await api('/plot?' + pass.toString());
      const png = Buffer.from(await upstream.arrayBuffer());
      res.writeHead(200, {
        'content-type': 'image/png',
        'content-length': png.length,
        'cache-control': 'no-store',
      });
      res.end(png);
      return;
    }

    if (req.method === 'POST') {
      const body = await readBody(req);
      if (body === null) {
        sendJson(res, 400, { ok: false, error: '请求体不是 JSON' });
        return;
      }
      await ensureBridge(cfg());

      if (path === `${ROUTE_PREFIX}/open`) {
        const payload = body.simulate
          ? { simulate: true }
          : { port: String(body.port ?? ''), baud: Number(body.baud ?? 115200) };
        sendJson(res, 200, await apiJson('/open', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }));
        return;
      }

      if (path === `${ROUTE_PREFIX}/close`) {
        sendJson(res, 200, await apiJson('/close', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        }));
        return;
      }

      if (path === `${ROUTE_PREFIX}/set`) {
        sendJson(res, 200, await apiJson('/set', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ values: Array.isArray(body.values) ? body.values : [] }),
        }));
        return;
      }

      if (path === `${ROUTE_PREFIX}/clear`) {
        sendJson(res, 200, await apiJson('/clear', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        }));
        return;
      }
    }

    sendJson(res, 404, { ok: false, error: '没有这个路由' });
  } catch (error) {
    // 页面要的是"为什么没成"，不是 500 空壳
    sendJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
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
  for (const make of [toolPorts, toolOpen, toolStatus, toolStats, toolSamples, toolPlot, toolSet]) {
    try {
      const dispose = ctx.tools.register(make());
      if (typeof dispose === 'function') disposers.push(dispose);
    } catch (err) {
      logger.error?.(`dsh-autopid: register ${make.name} failed: ${err.message}`);
    }
  }

  // 设置页面板用的同源路由。kind:'exact' 是 webServer 的契约：
  // 一条路径一次注册，所以这里一条条来。
  // 没有 webServer（比如纯 headless 的组合）就只跳过这段 —— 工具照常用，
  // 别让"少个网页"把整个插件带崩。
  if (!ctx.webServer) {
    // 纯 headless 组合本来就该这样，不算错，所以走 info
    logger.info?.('dsh-autopid: 没有 webServer 服务，设置页面板的路由不注册（工具照常可用，headless 组合正常）');
  } else {
    for (const path of ['/state', '/ports', '/plot.png', '/open', '/close', '/set', '/clear']) {
      ctx.effect(() => ctx.webServer.register({
        kind: 'exact',
        path: ROUTE_PREFIX + path,
        handler: handleRoute,
      }));
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
