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
import os from 'node:os';
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
// 调参规则就写在插件自己家：rules/tuning-rules.md（跟着插件走，不散落在外面）
const RULES_FILE = path.join(ROOT, 'rules', 'tuning-rules.md');
// 调参卡：人写的文件，默认在插件目录；可在设置里用 tuningCardPath 指到别处
const TUNING_CARD_FILE = path.join(ROOT, 'rules', 'tuning-card.md');

// ---------------------------------------------------------------- 图形化配置
//
// 面板里改的那些配置存在这儿：$DSH_HOME/autopid/settings.json
// 为什么不用 cordis 的 config：那是跟着 profile 走的 yaml，改一次要重启；
// 这里存一份 JSON，改完立刻生效（桥支持 /configure 热改）。
// 优先级：这个文件 > cordis.patch.yml 里的默认值。

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const SETTINGS_FILE = path.join(DSH_HOME, 'autopid', 'settings.json');

/** 面板里允许改的字段（串口名和波特率不在这里 —— 那两样归「打开串口」那块）。 */
const EDITABLE_KEYS = [
  'csvPath',
  'channels',
  'channelNames',
  'paramNames',
  'setFormat',
  'cmdStart',
  'cmdStop',
  'cmdReset',
  'tuneKpOsc',
  'tuneKiOsc',
  'tuneSpeed',
  'tuneSteady',
  'tuningCard',
  'tuningCardPath',
];

/** 把随便什么形状的输入收成插件认识的那份配置。 */
function normalizeConfig(src = {}) {
  const channels = Number(src.channels);
  return {
    python: String(src.python ?? 'python'),
    httpPort: Number(src.httpPort ?? 8765),
    port: String(src.port ?? ''),
    baud: Number(src.baud ?? 115200),
    csvPath: String(src.csvPath ?? ''),
    channels: Number.isFinite(channels) ? Math.max(0, Math.min(64, Math.round(channels))) : 0,
    channelNames: String(src.channelNames ?? ''),
    paramNames: String(src.paramNames ?? ''),
    setFormat: String(src.setFormat ?? 'positional') === 'named' ? 'named' : 'positional',
    cmdStart: String(src.cmdStart ?? ''),
    cmdStop: String(src.cmdStop ?? ''),
    cmdReset: String(src.cmdReset ?? ''),
    tuneKpOsc: clampWeight(src.tuneKpOsc, 40),
    tuneKiOsc: clampWeight(src.tuneKiOsc, 50),
    tuneSpeed: clampWeight(src.tuneSpeed, 50),
    tuneSteady: clampWeight(src.tuneSteady, 60),
    tuningCard: src.tuningCard === false || String(src.tuningCard) === 'false' ? false : true,
    tuningCardPath: String(src.tuningCardPath ?? ''),
  };
}

/** 调参权重：0~100 的整数，坏值回落到默认。 */
function clampWeight(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/** 读落盘的设置；文件坏了就当没有，不让它把插件带崩。 */
function loadSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    if (!raw || typeof raw !== 'object') return {};
    const picked = {};
    for (const key of EDITABLE_KEYS) {
      if (raw[key] !== undefined && raw[key] !== null) picked[key] = raw[key];
    }
    return picked;
  } catch {
    return {};
  }
}

/** 把这次改的字段并进去，写盘，返回完整设置。 */
function saveSettings(patch) {
  const current = loadSettings();
  for (const key of EDITABLE_KEYS) {
    if (patch && patch[key] !== undefined && patch[key] !== null) current[key] = patch[key];
  }
  try {
    fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(current, null, 2), 'utf8');
  } catch (err) {
    throw new Error(`设置没写进磁盘：${err.message}（${SETTINGS_FILE}）`);
  }
  return current;
}

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
    csvPath: z.string().default('').description('收到的数据追加到这个 .csv（绝对路径；空 = 不落盘）'),
    channels: z.natural().default(0).description('保留前几路数据；0 = 按第一行自动'),
    channelNames: z.string().default('').description('通道名，逗号分隔，如 L,R,PL,PR（决定 CSV 表头）'),
    paramNames: z.string().default('kp,ki,kd').description('下发参数的名字，逗号分隔；顺序 = 数值顺序'),
    setFormat: z.string().default('positional').description('参数下发格式：positional（SET 1.2 0.03）或 named（SET kp=1.2 ki=0.03）'),
    cmdStart: z.string().default('START').description('「启动」指令的正文，自动补换行'),
    cmdStop: z.string().default('STOP').description('「停止」指令的正文，自动补换行'),
    cmdReset: z.string().default('RESET').description('「重来」指令的正文，自动补换行'),
    tuneKpOsc: z.number().min(0).max(100).default(40)
      .description('调参关注度 0~100：Kp 引起的高频抖动（越大越不能容忍抖）'),
    tuneKiOsc: z.number().min(0).max(100).default(50)
      .description('调参关注度 0~100：Ki 引起的低频摆动/超调'),
    tuneSpeed: z.number().min(0).max(100).default(50)
      .description('调参关注度 0~100：响应速度（上升时间）'),
    tuneSteady: z.number().min(0).max(100).default(60)
      .description('调参关注度 0~100：稳态均值/稳态误差'),
    tuningCard: z.boolean().default(true)
      .description('把「调参卡」常驻进系统提示（关掉后模型只有主动调 autopid_tuning_rules 才看得到规则）'),
    tuningCardPath: z.string().default('')
      .description('调参卡文件路径（空 = 用插件自带的 rules/tuning-card.md）；填绝对路径可以放到你自己习惯的位置'),
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

/** 把配置里的逗号分隔字符串拆成数组。 */
function splitList(text) {
  return String(text ?? '')
    .replace(/，/g, ',')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

/** 要发给桥的那份配置（/configure 的 body）。 */
function bridgeConfig(config) {
  return {
    csv_path: String(config.csvPath ?? ''),
    channels: Number(config.channels ?? 0) || 0,
    channel_names: splitList(config.channelNames),
    param_names: splitList(config.paramNames),
    set_format: String(config.setFormat ?? 'positional'),
    cmd_start: String(config.cmdStart ?? ''),
    cmd_stop: String(config.cmdStop ?? ''),
    cmd_reset: String(config.cmdReset ?? ''),
  };
}

/**
 * 配置改了要同步给桥。桥支持热改（POST /configure），所以不用重启进程；
 * 用签名比较，没变就不发，省得每秒一次的轮询都在发请求。
 */
let lastSyncSignature = '';
async function syncConfig(config) {
  const body = bridgeConfig(config);
  const signature = JSON.stringify(body);
  if (signature === lastSyncSignature) return { synced: false };
  await apiJson('/configure', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  lastSyncSignature = signature;
  return { synced: true };
}

/** 把 bridge 拉起来。已经在跑就直接复用。 */
async function ensureBridge(config) {
  if (await alive()) {
    await syncConfig(config).catch((err) => {
      logger.warn?.(`dsh-autopid: 同步配置失败 ${err.message}`);
    });
    return { reused: true };
  }

  if (!fs.existsSync(BRIDGE_PY)) {
    throw new Error(`找不到 bridge 脚本：${BRIDGE_PY}`);
  }

  const args = [BRIDGE_PY, '--http', String(httpPort)];
  if (config.port) {
    args.push('--port', config.port, '--baud', String(config.baud || 115200));
  } else if (config.simulate) {
    args.push('--simulate');
  }
  // CSV / 通道 / 参数名 / 指令正文都在启动参数里带一份，
  // 后面还能用 /configure 热改（这里只是让新起的桥一开始就是对的）。
  const boot = bridgeConfig(config);
  if (boot.csv_path) args.push('--csv', boot.csv_path);
  if (boot.channels) args.push('--channels', String(boot.channels));
  if (boot.channel_names.length) args.push('--channel-names', boot.channel_names.join(','));
  if (boot.param_names.length) args.push('--param-names', boot.param_names.join(','));
  if (boot.set_format) args.push('--set-format', boot.set_format);
  if (boot.cmd_start) args.push('--cmd-start', boot.cmd_start);
  if (boot.cmd_stop) args.push('--cmd-stop', boot.cmd_stop);
  if (boot.cmd_reset) args.push('--cmd-reset', boot.cmd_reset);
  lastSyncSignature = JSON.stringify(boot);

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

/**
 * 面板（或工具）改配置时走这里：写盘 → 更新内存 → 立刻同步给桥。
 * 不用重启 DSH，也不用重启桥。
 */
async function updateSettings(patch) {
  const clean = { ...patch };
  if (clean.channels === '' || clean.channels === null) clean.channels = 0;
  const stored = saveSettings(clean);
  currentConfig = normalizeConfig({ ...currentConfig, ...stored });
  httpPort = currentConfig.httpPort;
  lastSyncSignature = '';
  const outcome = await ensureBridge(currentConfig)
    .then(() => ({ synced: true }))
    .catch((err) => ({ synced: false, error: err.message }));
  return { config: currentConfig, stored, outcome };
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
    if (v?.error) return `没读到数据：${v.error}`;
    return '这段时间里没有数据。先 autopid_status 看看串口通不通、CSV 里有没有写进去。';
  }
  const names = Array.isArray(v.names) && v.names.length
    ? v.names
    : v.rows[0].slice(1).map((_, i) => `CH${i}`);
  const head = [
    `来源：${v.source === 'csv' ? `CSV 文件 ${v.path}` : '实时缓冲'}`,
    `${v.rows.length} 点，t0=${v.t0}`,
    `列：t, ${names.join(', ')}`,
  ].join(' | ');
  const lines = v.rows.map((row) => {
    const [t, ...vals] = row;
    return [String(t).padStart(12), ...vals.map((x) => String(x).padStart(12))].join(' ');
  });
  const more = v.truncated ? [`……这一份共有 ${v.total} 点，只给了前 ${v.rows.length} 个；要更细就加 limit 或缩小时间窗`] : [];
  return [head, ...lines, ...more].join('\n');
}

function toolSamples() {
  return {
    name: 'autopid_samples',
    description:
      '读采样数据：默认读配置里那个 .csv 落盘文件（也可以指定 file 读任意 CSV），每个点给出时间戳和各通道数值，一行一个点。' +
      '想看波形具体长什么样、想自己算超调/上升时间/稳态误差时用它；只要统计特征（min/max/峰峰/振荡频率）用 autopid_stats 更快。' +
      '没配 CSV 的时候会退回读实时缓冲，回执里会写明来源。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        file: { type: 'string', description: '指定 CSV 绝对路径；不传就用配置里的 csvPath' },
        window: { type: 'number', description: '只看最近多少秒（按 t 列）；给 start/end 时忽略' },
        start: { type: 'number', description: '起始时间（秒，Unix）；和 end 配对使用' },
        end: { type: 'number', description: '结束时间（秒，Unix）' },
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
      const config = cfg();
      await ensureBridge(config);
      const limit = Math.min(2000, Math.max(1, Number(args?.limit ?? 80)));
      const file = String(args?.file ?? config.csvPath ?? '').trim();

      // 有 CSV 就读 CSV（存下来的那份才是真源）；没有才退回实时缓冲
      if (file) {
        const qs = new URLSearchParams();
        qs.set('path', file);
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
        const raw = await apiJson('/csv?' + qs.toString());
        if (raw?.ok) {
          const header = Array.isArray(raw.header) ? raw.header : [];
          const names = Array.isArray(args?.channels) && args.channels.length
            ? args.channels.map((i) => header[i + 1] ?? `CH${i}`)
            : header.slice(1);
          return {
            source: 'csv',
            path: raw.path,
            names,
            t0: raw.t0 ?? null,
            rows: raw.rows ?? [],
            total: raw.total ?? 0,
            truncated: (raw.total ?? 0) > (raw.rows?.length ?? 0),
          };
        }
        // CSV 读不到时把原因带回去，别悄悄换来源
        const fallback = await liveSamples(qs, limit, args);
        return { ...fallback, error: raw?.error ?? '读 CSV 失败' };
      }

      return await liveSamples(null, limit, args);
    },
  };
}

/** 读实时缓冲（没有 CSV 时的退路）。 */
async function liveSamples(_qs, limit, args) {
  const qs = new URLSearchParams();
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
  const names = splitList(cfg().channelNames);
  return {
    source: 'buffer',
    path: '',
    names,
    t0: raw?.t0 ?? null,
    rows: raw?.rows ?? [],
    total: raw?.total ?? raw?.rows?.length ?? 0,
    truncated: Boolean(raw?.truncated),
  };
}


/** 下发任何东西之后，都顺手看一眼"有没有新数据进来" —— 这是单片机反应的硬证据。 */
async function sendAndObserve(send, waitMs) {
  const before = await apiJson('/status').catch(() => null);
  const res = await send();
  if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
  const after = await apiJson('/status').catch(() => null);
  const beforeLines = typeof before?.lines === 'number' ? before.lines : null;
  const afterLines = typeof after?.lines === 'number' ? after.lines : null;
  return {
    ...res,
    waited_ms: waitMs,
    lines_before: beforeLines,
    lines_after: afterLines,
    new_lines: beforeLines !== null && afterLines !== null ? afterLines - beforeLines : null,
    last_line: after?.last_line ?? null,
  };
}

/** 下发类回执共用的措辞：有反应 / 没观察到（不等于没生效）/ 没发出去。 */
function fmtSendResult(v, what) {
  const err = String(v?.error ?? '');
  if (!v?.ok) {
    return err.includes('serial not open')
      ? `没发出去：串口没开着。先用 autopid_open 打开串口再发${what}。`
      : `发送失败：${err || '未知原因'}`;
  }
  const lines = [`已发送${what}：${v.sent}`];
  if (Array.isArray(v.param_names) && v.param_names.length) {
    lines.push(`参数名（按顺序）：${v.param_names.join(' / ')}；格式：${v.set_format === 'named' ? '命名' : '按位置'}`);
  }
  if (v.new_lines === null) {
    lines.push('发完没能读到状态，单片机有没有反应看不出来。');
  } else if (v.new_lines > 0) {
    lines.push(`发完之后 ${v.waited_ms} 毫秒里新来了 ${v.new_lines} 行，单片机在发数据。最后一行：${v.last_line || '(空)'}`);
  } else {
    lines.push(`发完之后 ${v.waited_ms} 毫秒里一行新数据都没有 —— 单片机没回话，或者它本来就不输出。这一条只是"没观察到"，不等于"指令没生效"。`);
  }
  return lines.join('\n');
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
      render: (_a, v) => [{ type: 'text', text: fmtSendResult(v, '参数') }],
    },
    async execute(args) {
      await ensureBridge(cfg());
      const waitMs = Math.min(5000, Math.max(0, Number(args?.waitMs ?? 400)));
      return await sendAndObserve(
        () => (args?.raw
          ? apiJson('/raw', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: String(args.raw) }),
          })
          : apiJson('/set', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ values: args?.values ?? [] }),
          })),
        waitMs,
      );
    },
  };
}

function toolCommand() {
  return {
    name: 'autopid_command',
    description:
      '给单片机下发「启动 / 停止 / 重来」指令。三条指令的正文是在插件配置里自己编辑的（cmdStart / cmdStop / cmdReset），' +
      '所以想发什么文本都行；action=raw 还能发任意内容。发完之后同样回报有没有新数据进来，用来看单片机有没有反应。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: ['start', 'stop', 'reset', 'raw'],
          description: 'start=启动，stop=停止，reset=重来；raw=发 raw 字段里的原文',
        },
        raw: { type: 'string', description: 'action=raw 时要发的文本（会补一个换行）' },
        waitMs: {
          type: 'number',
          description: '发完之后等多久再看有没有新数据，默认 400 毫秒',
        },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: fmtSendResult(v, '指令') }],
    },
    async execute(args) {
      const config = cfg();
      await ensureBridge(config);
      const action = String(args?.action ?? '').toLowerCase();
      const waitMs = Math.min(5000, Math.max(0, Number(args?.waitMs ?? 400)));

      if (action === 'raw') {
        const text = String(args?.raw ?? '');
        if (!text.trim()) {
          throw new Error('action=raw 时要给 raw 文本');
        }
        return await sendAndObserve(
          () => apiJson('/raw', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text }),
          }),
          waitMs,
        );
      }

      const known = ['start', 'stop', 'reset'];
      if (!known.includes(action)) {
        throw new Error(`action 只认 start / stop / reset / raw，收到的是「${action}」`);
      }
      return await sendAndObserve(
        () => apiJson('/command', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action }),
        }),
        waitMs,
      );
    },
  };
}

function toolTuningRules() {
  return {
    name: 'autopid_tuning_rules',
    description:
      '读插件内置的调参规则（rules/tuning-rules.md），连同当前四个关注度权重一起返回。'
      + '调参之前必须先读它，按它的顺序和红线来做，不要凭自己的直觉加倍增益。'
      + '如果传入 metrics（steadyErr / riseMs / ripple / swing，单位见规则），'
      + '还会按当前权重算出这次候选参数组合的分数（越高越好），方便横向比较。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        metrics: {
          type: 'object',
          description: '可选：这次实验的指标，用来按权重打分',
          additionalProperties: true,
          properties: {
            steadyErr: { type: 'number', description: '稳态误差，百分比（取绝对值，如 1.2 表示 1.2%）' },
            riseMs: { type: 'number', description: '上升时间，毫秒' },
            ripple: { type: 'number', description: '稳态段高频抖动，占目标值的百分比' },
            swing: { type: 'number', description: '低频摆动/超调，占目标值的百分比' },
          },
        },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => {
        const lines = [`规则文件：${v?.file || '（没读到）'}`];
        const w = v?.weights ?? {};
        lines.push(
          `权重：Kp抖动 ${w.tuneKpOsc} · Ki摆动 ${w.tuneKiOsc} · 响应速度 ${w.tuneSpeed} · 稳态均值 ${w.tuneSteady}`,
        );
        if (v?.score !== undefined) {
          lines.push(`这次打分：${v.score}（${v.verdict}）`);
        }
        if (v?.error) lines.push(`读规则失败：${v.error}`);
        if (v?.rules) lines.push('', v.rules);
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(args) {
      const w = cfg();
      const weights = {
        tuneKpOsc: w.tuneKpOsc,
        tuneKiOsc: w.tuneKiOsc,
        tuneSpeed: w.tuneSpeed,
        tuneSteady: w.tuneSteady,
      };
      let rules = '';
      let readError;
      try {
        rules = fs.readFileSync(RULES_FILE, 'utf8');
      } catch (err) {
        readError = err instanceof Error ? err.message : String(err);
      }
      rules = rules
        .replaceAll('{{kpOsc}}', String(weights.tuneKpOsc))
        .replaceAll('{{kiOsc}}', String(weights.tuneKiOsc))
        .replaceAll('{{speed}}', String(weights.tuneSpeed))
        .replaceAll('{{steady}}', String(weights.tuneSteady));

      // 关键：返回值里不能有 undefined 字段 —— 工具输出校验会报「不是无损 JSON」
      const out = { file: RULES_FILE, weights, rules };
      if (readError) out.error = readError;

      const m = args?.metrics;
      if (!m) return out;

      const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);
      const steady = num(m.steadyErr);
      const rise = num(m.riseMs);
      const ripple = num(m.ripple);
      const swing = num(m.swing);
      // 与规则文件第一节的公式保持一致
      const raw = 100
        - (weights.tuneSteady * steady) / 100
        - (weights.tuneSpeed * rise) / 100
        - (weights.tuneKpOsc * ripple) / 100
        - (weights.tuneKiOsc * swing) / 100;
      const score = Math.round(Math.max(0, Math.min(100, raw)) * 10) / 10;

      let verdict = '一般';
      if (steady > 15 || ripple > 15) verdict = '不能用：误差或抖动超出红线';
      else if (score >= 85) verdict = '很好';
      else if (score >= 70) verdict = '可用';
      else if (score >= 50) verdict = '勉强，建议再调一档';

      return {
        ...out,
        score,
        verdict,
        inputs: { steadyErr: steady, riseMs: rise, ripple, swing },
      };
    },
  };
}

function toolConfig() {
  return {
    name: 'autopid_config',
    description:
      '看 / 改插件的采集配置（跟设置页那个表单是同一份数据，改完立即生效，写进 '
      + '$DSH_HOME/autopid/settings.json）。能改的字段：csvPath（CSV 落盘路径）、channels（保留前几路，0=自动）、'
      + 'channelNames、paramNames、setFormat、cmdStart/cmdStop/cmdReset。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        patch: {
          type: 'object',
          description: '要改的字段；不传就是只读',
          additionalProperties: true,
        },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => {
        const c = v?.config ?? {};
        const lines = [
          `CSV：${c.csvPath || '（不落盘）'}`,
          `通道：${c.channels || '自动'} 路 · 名字：${c.channelNames || '（未设置）'}`,
          `参数：${c.paramNames || '（未设置）'} · 格式：${c.setFormat}`,
          `指令：启动「${c.cmdStart || ''}」 停止「${c.cmdStop || ''}」 重来「${c.cmdReset || ''}」`,
          `调参关注度：Kp抖动 ${c.tuneKpOsc ?? 40} · Ki摆动 ${c.tuneKiOsc ?? 50}`
            + ` · 响应速度 ${c.tuneSpeed ?? 50} · 稳态均值 ${c.tuneSteady ?? 60}`,
        ];
        if (v?.bridge?.synced === false) lines.push(`但没同步给桥：${v.bridge.error}`);
        if (v?.file) lines.push(`存到：${v.file}`);
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(args) {
      if (!args?.patch) {
        return { config: cfg(), file: SETTINGS_FILE };
      }
      const result = await updateSettings(args.patch);
      return { config: result.config, file: SETTINGS_FILE, bridge: result.outcome };
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

    if (path === `${ROUTE_PREFIX}/config` && req.method === 'GET') {
      await ensureBridge(cfg());
      sendJson(res, 200, { ok: true, ...(await apiJson('/config')) });
      return;
    }

    if (path === `${ROUTE_PREFIX}/settings` && req.method === 'GET') {
      sendJson(res, 200, {
        ok: true,
        config: cfg(),
        file: SETTINGS_FILE,
        editable: EDITABLE_KEYS,
      });
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

      if (path === `${ROUTE_PREFIX}/settings`) {
        const result = await updateSettings(body);
        sendJson(res, 200, {
          ok: true,
          config: result.config,
          file: SETTINGS_FILE,
          bridge: result.outcome,
        });
        return;
      }

      if (path === `${ROUTE_PREFIX}/command`) {
        const action = String(body.action ?? '').toLowerCase();
        if (action === 'raw') {
          sendJson(res, 200, await apiJson('/raw', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: String(body.raw ?? '') }),
          }));
          return;
        }
        sendJson(res, 200, await apiJson('/command', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action }),
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

let currentConfig = {
  python: 'python',
  httpPort: 8765,
  port: '',
  baud: 115200,
  csvPath: '',
  channels: 0,
  channelNames: '',
  paramNames: 'kp,ki,kd',
  setFormat: 'positional',
  cmdStart: 'START',
  cmdStop: 'STOP',
  cmdReset: 'RESET',
  tuneKpOsc: 40,
  tuneKiOsc: 50,
  tuneSpeed: 50,
  tuneSteady: 60,
  tuningCard: true,
  tuningCardPath: '',
};

function cfg() {
  return currentConfig;
}

// ---------------------------------------------------------------- 调参卡（人工设置的文件，常驻系统提示）

/**
 * 调参卡的正文。
 * 卡本体是**人写的文件**（默认 rules/tuning-card.md，可用 tuningCardPath 指到别处），
 * 每轮现读现注入 —— 人改文件就等于改调参卡，不用重启、不用改代码。
 * 文件里写 {{kpOsc}} / {{kiOsc}} / {{speed}} / {{steady}} 会被替换成滑块上的当前值，
 * 没写占位符就一字不改地原样注入。读不到文件时退回下面这段内置兜底。
 */
function tuningCardText() {
  const c = cfg();
  if (c.tuningCard === false) return '';

  const kp = c.tuneKpOsc;
  const ki = c.tuneKiOsc;
  const speed = c.tuneSpeed;
  const steady = c.tuneSteady;

  const cardPath = c.tuningCardPath && c.tuningCardPath.trim() ? c.tuningCardPath.trim() : TUNING_CARD_FILE;
  let body = '';
  try {
    body = fs.readFileSync(cardPath, 'utf8');
  } catch {
    body = '';
  }

  if (!body.trim()) {
    body = [
      '【autoPID 调参卡】涉及 PID 调参时按这张卡来，不要凭直觉加大增益。',
      `当前关注度：Kp 抖动 ${kp} · Ki 摆动 ${ki} · 响应速度 ${speed} · 稳态均值 ${steady}（0~100）`,
      '稳态追不上先加 Ki（增量式的稳态误差靠 Ki）；追得上但慢再动 Kp，一档一档来；只有超调明显才动 Kd。',
      '红线：先 STOP 再改；单步放大不超过 2 倍，超了先问人；能空转就空转；异常先退回上一组安全值。',
      '汇报三段：试了什么 / 数据怎么说 / 下一步建议。',
    ].join('\n');
  }

  return body
    .replaceAll('{{kpOsc}}', String(kp))
    .replaceAll('{{kiOsc}}', String(ki))
    .replaceAll('{{speed}}', String(speed))
    .replaceAll('{{steady}}', String(steady))
    .trim();
}

/** 把调参卡挂进系统提示。systemPrompt 可能比插件晚就绪，所以带重试。 */
function registerTuningCard(ctx, disposers) {
  let tries = 0;
  const attach = () => {
    const svc = ctx.get?.('systemPrompt');
    if (!svc || typeof svc.section !== 'function') {
      if (tries++ < 20) {
        setTimeout(attach, 1000);
      } else {
        logger.warn?.('dsh-autopid: systemPrompt 20 秒内没就绪，调参卡没挂上（工具照常可用）');
      }
      return;
    }
    try {
      const dispose = svc.section({ name: 'dsh-autopid:tuning-card', order: 150, text: tuningCardText });
      if (typeof dispose === 'function') disposers.push(dispose);
      logger.info?.('dsh-autopid: 调参卡已挂进 system prompt');
    } catch (err) {
      logger.warn?.(`dsh-autopid: 调参卡注册失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };
  attach();
}

/** 装配后的总入口。 */
export function apply(ctx, config = {}) {
  if (ctx?.logger) logger = ctx.logger;
  // 顺序：cordis 的默认值 打底 → 面板里存过的覆盖（那是操作者最后一次明确的意图）
  currentConfig = normalizeConfig({ ...config, ...loadSettings() });
  httpPort = currentConfig.httpPort;
  // 配置变了（设置页里热改）就得让桥那边跟着改，所以清掉签名缓存
  lastSyncSignature = '';

  logger.info?.(
    `dsh-autopid: ready (python=${currentConfig.python}, http=${httpPort}, port=${currentConfig.port || '(none)'}, `
    + `csv=${currentConfig.csvPath || '(off)'}, channels=${currentConfig.channels || 'auto'}, `
    + `params=${currentConfig.paramNames || '(none)'})`,
  );

  const disposers = [];
  for (const make of [toolPorts, toolOpen, toolStatus, toolStats, toolSamples, toolPlot, toolSet, toolCommand, toolConfig, toolTuningRules]) {
    try {
      const dispose = ctx.tools.register(make());
      if (typeof dispose === 'function') disposers.push(dispose);
    } catch (err) {
      logger.error?.(`dsh-autopid: register ${make.name} failed: ${err.message}`);
    }
  }

  // 调参卡：把"按什么标准调"常驻进系统提示，免得模型忘了先读规则就凭直觉加倍增益。
  // systemPrompt 是可选服务（headless 组合里可能没有），所以用 ctx.get + 重试，别写进 inject
  // —— 写进 inject 的话，缺这个服务的 profile 会让整个插件不激活。
  registerTuningCard(ctx, disposers);

  // 设置页面板用的同源路由。kind:'exact' 是 webServer 的契约：
  // 一条路径一次注册，所以这里一条条来。
  // 没有 webServer（比如纯 headless 的组合）就只跳过这段 —— 工具照常用，
  // 别让"少个网页"把整个插件带崩。
  if (!ctx.webServer) {
    // 纯 headless 组合本来就该这样，不算错，所以走 info
    logger.info?.('dsh-autopid: 没有 webServer 服务，设置页面板的路由不注册（工具照常可用，headless 组合正常）');
  } else {
    for (const path of ['/state', '/config', '/settings', '/ports', '/plot.png', '/open', '/close', '/set', '/command', '/clear']) {
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
