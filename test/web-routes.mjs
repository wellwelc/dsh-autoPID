// 验证 Host 那半的 /api/autopid/* 路由：真起一个 bridge（模拟数据），
// 再用假的 ctx 把 apply() 跑起来，直接调注册进去的 handler。
// 不碰 DSH、不碰真串口，跑完自己收场。
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// 用临时 DSH_HOME，别把测试写进真实的设置文件
process.env.DSH_HOME = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'out', 'test-dsh-web');
fs.rmSync(process.env.DSH_HOME, { recursive: true, force: true });

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8799;
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

function fakeReq({ url, method = 'GET', body, ip = '127.0.0.1' }) {
  const req = new EventEmitter();
  req.url = url;
  req.method = method;
  req.socket = { remoteAddress: ip };
  req.destroy = () => {};
  setTimeout(() => {
    if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
  }, 0);
  return req;
}

function fakeRes() {
  return {
    status: 0,
    headers: null,
    body: null,
    writeHead(code, headers) {
      this.status = code;
      this.headers = headers;
    },
    end(payload) {
      this.body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
    },
  };
}

async function call(handler, opts) {
  const req = fakeReq(opts);
  const res = fakeRes();
  await handler(req, res);
  return res;
}

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const bridge = spawn('python', [path.join(ROOT, 'bridge', 'bridge.py'), '--simulate', '--http', String(PORT)], {
  cwd: path.join(ROOT, 'bridge'),
  stdio: 'ignore',
  windowsHide: true,
});

let exitCode = 1;
try {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && !(await alive())) await sleep(200);
  check('bridge 起来了（模拟数据）', await alive(), `http://127.0.0.1:${PORT}`);

  const mod = await import(pathToFileURL(path.join(ROOT, 'lib', 'index.js')).href);
  check('inject 里有 tools 和 webServer',
    Array.isArray(mod.inject) && mod.inject.includes('tools') && mod.inject.includes('webServer'),
    JSON.stringify(mod.inject));

  const handlers = new Map();
  const tools = [];
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    tools: { register: (tool) => { tools.push(tool.name); return () => {}; } },
    webServer: {
      register: (entry) => {
        handlers.set(entry.path, entry.handler);
        return () => {};
      },
    },
    effect: (fn) => {
      const dispose = fn();
      return typeof dispose === 'function' ? dispose : () => {};
    },
  };

  mod.apply(ctx, {
    python: 'python',
    httpPort: PORT,
    port: '',
    baud: 115200,
    paramNames: 'kp,ki,kd',
    cmdStart: 'START',
  });

  check('九个工具都注册了', tools.length === 9 && tools.includes('autopid_samples')
    && tools.includes('autopid_command') && tools.includes('autopid_config'), tools.join(','));
  const paths = [...handlers.keys()].sort();
  check('十条路由都挂上了', paths.length === 10, paths.join(' '));

  // 等模拟数据攒一点
  await sleep(1200);

  const st = await call(handlers.get('/api/autopid/state'), { url: '/api/autopid/state' });
  const stJson = JSON.parse(st.body.toString());
  check('GET /state 回 ok + status', stJson.ok === true && stJson.status?.buffer > 0,
    `buffer=${stJson.status?.buffer} channels=${stJson.status?.channels}`);

  const ports = await call(handlers.get('/api/autopid/ports'), { url: '/api/autopid/ports' });
  const portsJson = JSON.parse(ports.body.toString());
  check('GET /ports 回数组', portsJson.ok === true && Array.isArray(portsJson.ports),
    `端口 ${portsJson.ports?.length ?? 0} 个`);

  const png = await call(handlers.get('/api/autopid/plot.png'),
    { url: '/api/autopid/plot.png?window=2&norm=0&t=123' });
  const isPng = png.body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  check('GET /plot.png 回真 PNG', png.status === 200 && isPng && png.body.length > 2000,
    `${png.body.length} 字节, content-type=${png.headers?.['content-type']}`);
  fs.writeFileSync(path.join(ROOT, 'out', 'web-route-check.png'), png.body);

  const open = await call(handlers.get('/api/autopid/open'),
    { url: '/api/autopid/open', method: 'POST', body: { simulate: true } });
  check('POST /open 切模拟数据', JSON.parse(open.body.toString()).ok === true, open.body.toString());

  const set = await call(handlers.get('/api/autopid/set'),
    { url: '/api/autopid/set', method: 'POST', body: { values: [1.2, 0.03, 0.3] } });
  const setJson = JSON.parse(set.body.toString());
  check('POST /set 没开真串口时老实报失败', setJson.ok === false && typeof setJson.error === 'string',
    `error=${setJson.error}`);

  const cfg = await call(handlers.get('/api/autopid/config'), { url: '/api/autopid/config' });
  const cfgJson = JSON.parse(cfg.body.toString());
  check('GET /config 回参数名和指令正文',
    cfgJson.ok === true
      && Array.isArray(cfgJson.param_names) && cfgJson.param_names.length === 3
      && typeof cfgJson.cmd_start === 'string',
    `param_names=${JSON.stringify(cfgJson.param_names)} cmd_start=${cfgJson.cmd_start}`);

  const cmd = await call(handlers.get('/api/autopid/command'),
    { url: '/api/autopid/command', method: 'POST', body: { action: 'start' } });
  const cmdJson = JSON.parse(cmd.body.toString());
  check('POST /command 没开串口时老实报失败', cmdJson.ok === false, `error=${cmdJson.error}`);

  const settings0 = await call(handlers.get('/api/autopid/settings'), { url: '/api/autopid/settings' });
  const settingsJson = JSON.parse(settings0.body.toString());
  check('GET /settings 回配置和文件路径',
    settingsJson.ok === true && typeof settingsJson.file === 'string' && settingsJson.file.includes('settings.json'),
    settingsJson.file);

  const saved = await call(handlers.get('/api/autopid/settings'), {
    url: '/api/autopid/settings',
    method: 'POST',
    body: { channels: 2, channelNames: 'L,R', paramNames: 'p,i,d', cmdStart: 'GO' },
  });
  const savedJson = JSON.parse(saved.body.toString());
  check('POST /settings 生效并写盘',
    savedJson.ok === true && savedJson.config.channels === 2 && savedJson.config.paramNames === 'p,i,d'
      && fs.existsSync(savedJson.file),
    `channels=${savedJson.config?.channels} file=${savedJson.file}`);

  const cfg2 = await call(handlers.get('/api/autopid/config'), { url: '/api/autopid/config' });
  const cfg2Json = JSON.parse(cfg2.body.toString());
  check('改完立刻同步给桥', (cfg2Json.param_names ?? []).join(',') === 'p,i,d' && cfg2Json.cmd_start === 'GO',
    `param_names=${JSON.stringify(cfg2Json.param_names)} cmd_start=${cfg2Json.cmd_start}`);

  const forbidden = await call(handlers.get('/api/autopid/state'),
    { url: '/api/autopid/state', ip: '10.0.0.9' });
  check('非本机访问被挡', forbidden.status === 403, String(forbidden.status));

  const missing = await call(handlers.get('/api/autopid/state'), { url: '/api/autopid/nope' });
  check('没这条路由回 404', missing.status === 404, String(missing.status));

  exitCode = checks.every((c) => c.ok) ? 0 : 1;
} catch (error) {
  console.log('TEST ERROR', error);
} finally {
  try {
    bridge.kill();
  } catch {}
  await sleep(300);
  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} 通过`);
  process.exit(exitCode);
}
