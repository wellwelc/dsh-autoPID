// 只验 /api/autopid/card 这条路由：读卡、写卡、路径跟着 tuningCardPath 走。
// 用假 req/res 直接调 handleRoute，不启 bridge、不碰串口。
// ⚠️ 全程只碰 DSH_HOME 下的临时卡文件，绝不写仓库里的 rules/tuning-card.md。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOME = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'out', 'test-dsh-card');
process.env.DSH_HOME = HOME;
fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(path.join(HOME, 'autopid'), { recursive: true });

const settingsFile = path.join(HOME, 'autopid', 'settings.json');
const cardFile = path.join(HOME, 'card-test.md');
fs.writeFileSync(cardFile, '【初始卡】Kp 抖动 {{kpOsc}}', 'utf8');
fs.writeFileSync(settingsFile, JSON.stringify({ tuningCardPath: cardFile }), 'utf8');

const { apply } = await import('../lib/index.js');

let routeHandler = null;
const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  tools: { register: () => () => {} },
  get: () => undefined,
  effect: (fn) => { const d = fn?.(); return () => d?.(); },
  webServer: {
    register: ({ path: p, handler }) => {
      if (p.endsWith('/card')) routeHandler = handler;
      return () => {};
    },
  },
};

apply(ctx, {});
if (!routeHandler) throw new Error('没注册 /card 路由');

const ROUTE = '/api/autopid/card';

function fakeReq(method, url, bodyObj) {
  const chunks = bodyObj === undefined ? [] : [Buffer.from(JSON.stringify(bodyObj), 'utf8')];
  return {
    method,
    url,
    socket: { remoteAddress: '127.0.0.1' },
    on(event, cb) {
      if (event === 'data') chunks.forEach((c) => cb(c));
      if (event === 'end') setTimeout(cb, 0);
      if (event === 'error') { /* noop */ }
    },
    destroy() {},
  };
}

function fakeRes() {
  const res = {
    statusCode: 0,
    headers: null,
    payload: '',
    writeHead(code, headers) { res.statusCode = code; res.headers = headers; },
    end(chunk) { if (chunk) res.payload += chunk.toString(); },
  };
  return res;
}

async function call(method, body) {
  const res = fakeRes();
  await routeHandler(fakeReq(method, ROUTE, body), res);
  if (!res.payload) throw new Error(`路由没回东西（${method}）`);
  return JSON.parse(res.payload);
}

// 1. 读：路径跟着配置走
const got = await call('GET');
console.log('读卡：path =', got.path);
if (path.resolve(got.path) !== path.resolve(cardFile)) throw new Error('路径没跟着 tuningCardPath 走');
if (!got.exists) throw new Error('卡文件应该存在');
if (!got.effective.includes('Kp 抖动 40')) throw new Error(`effective 里占位符没替换：${got.effective}`);

// 2. 写：改内容，再读回来
const saved = await call('POST', { content: '【测试卡】只看抖动 {{kpOsc}}，其余不管' });
if (!saved.ok) throw new Error('写卡失败：' + saved.error);
if (!fs.readFileSync(cardFile, 'utf8').includes('【测试卡】')) throw new Error('磁盘上的内容没变');
if (!saved.effective.includes('只看抖动 40')) throw new Error('写入后 effective 没更新');
console.log('写卡：ok，effective =', saved.effective.trim());

// 3. 占位符替换用的是"当前权重"，改权重后 effective 要变
fs.writeFileSync(settingsFile, JSON.stringify({ tuningCardPath: cardFile, tuneKpOsc: 88 }), 'utf8');
apply(ctx, {});
const got2 = await call('GET');
if (!got2.effective.includes('只看抖动 88')) throw new Error(`权重改了 effective 没跟着变：${got2.effective}`);
console.log('改权重后 effective =', got2.effective.trim());

// 4. 换到一个还不存在的路径：能读（exists=false），写入后自动建目录建文件
const deepPath = path.join(HOME, 'deep', 'dir', 'card.md');
fs.writeFileSync(settingsFile, JSON.stringify({ tuningCardPath: deepPath }), 'utf8');
apply(ctx, {});
const got3 = await call('GET');
if (got3.exists) throw new Error('新路径不该已经存在');
const saved3 = await call('POST', { content: '深层路径的卡' });
if (!saved3.ok) throw new Error('深层路径写卡失败：' + saved3.error);
if (!fs.existsSync(deepPath)) throw new Error('深层路径没被创建');

// 5. 超长内容要被挡掉
const huge = await call('POST', { content: 'x'.repeat(65 * 1024) });
if (huge.ok) throw new Error('超长内容应该被拒绝');
console.log('超长内容：', huge.error);

console.log('\nOK');
