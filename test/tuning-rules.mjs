// 只验调参规则这一块：工具能注册、能读规则文件、能按权重打分。
// 不碰串口、不起 bridge —— 纯逻辑。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.DSH_HOME = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'out', 'test-dsh-rules');
fs.rmSync(process.env.DSH_HOME, { recursive: true, force: true });

const { apply } = await import('../lib/index.js');

const tools = new Map();
const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  tools: { register: (t) => { tools.set(t.name, t); return () => {}; } },
  effect: () => () => {},
};

apply(ctx, {});

const names = [...tools.keys()];
console.log('注册的工具：', names.join(', '));
if (!names.includes('autopid_tuning_rules')) throw new Error('没注册 autopid_tuning_rules');

const tool = tools.get('autopid_tuning_rules');

const plain = await tool.execute({});
if (!plain.rules || plain.rules.length < 500) throw new Error('规则文件没读到或太短');
if (plain.rules.includes('{{')) throw new Error('占位符没被替换');
console.log('规则字数 =', plain.rules.length, '| 权重 =', JSON.stringify(plain.weights));
console.log('--- 规则前 6 行 ---');
console.log(plain.rules.split('\n').slice(0, 6).join('\n'));

const scored = await tool.execute({ metrics: { steadyErr: 1.2, riseMs: 46, ripple: 2.2, swing: 5.6 } });
console.log('\n打分（好的一组）=', scored.score, '|', scored.verdict);

const bad = await tool.execute({ metrics: { steadyErr: 58, riseMs: 900, ripple: 25, swing: 60 } });
console.log('打分（差的一组）=', bad.score, '|', bad.verdict);
if (!(scored.score > bad.score)) throw new Error('好的一组居然不比差的分数高');

const rendered = tool.output.render({}, plain).map((p) => p.type).join(',');
console.log('render 段 =', rendered);
if (rendered.includes('image')) throw new Error('render 里出现 image');

// 权重改成 100/0/0/0 之后，抖动主导分数
const settingsFile = path.join(process.env.DSH_HOME, 'autopid', 'settings.json');
fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
fs.writeFileSync(settingsFile, JSON.stringify({ tuneKpOsc: 100, tuneKiOsc: 0, tuneSpeed: 0, tuneSteady: 0 }), 'utf8');

apply(ctx, {});
const tool2 = tools.get('autopid_tuning_rules');
const reWeighted = await tool2.execute({ metrics: { steadyErr: 0, riseMs: 0, ripple: 50, swing: 0 } });
console.log('抖动权重 100 时，纹波 50% 的分数 =', reWeighted.score, '|', reWeighted.verdict);
if (reWeighted.score >= 60) throw new Error('权重 100 时纹波 50% 不应该还能得高分');

console.log('\nOK');
