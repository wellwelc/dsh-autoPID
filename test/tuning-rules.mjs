// 只验调参规则 + 调参卡：工具能注册、规则能读、打分对、卡片挂进系统提示且跟着权重变。
// 不碰串口、不起 bridge —— 纯逻辑。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.DSH_HOME = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'out', 'test-dsh-rules');
fs.rmSync(process.env.DSH_HOME, { recursive: true, force: true });

const { apply } = await import('../lib/index.js');

const tools = new Map();
const sections = new Map();
const fakeSystemPrompt = {
  section({ name, order, text }) {
    sections.set(name, { order, text });
    return () => sections.delete(name);
  },
};

const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  tools: { register: (t) => { tools.set(t.name, t); return () => {}; } },
  get: (name) => (name === 'systemPrompt' ? fakeSystemPrompt : undefined),
  effect: () => () => {},
};

apply(ctx, {});

const names = [...tools.keys()];
console.log('注册的工具：', names.join(', '));
if (!names.includes('autopid_tuning_rules')) throw new Error('没注册 autopid_tuning_rules');

const cardOf = () => {
  const card = sections.get('dsh-autopid:tuning-card');
  if (!card) throw new Error('调参卡没挂进 system prompt');
  return typeof card.text === 'function' ? card.text() : card.text;
};

// -- 调参卡 --
const cardText = cardOf();
console.log('调参卡长度 =', cardText.length);
if (!cardText.includes('Kp 抖动 40')) throw new Error('调参卡里的占位符没被替换：' + cardText.slice(0, 120));
if (!cardText.includes('先调工具')) { /* 卡文件里没写工具指引也允许 */ }
if (!cardText.includes('单步放大不超过 2 倍')) throw new Error('调参卡漏了红线');

// -- 工具本体 --
const tool = tools.get('autopid_tuning_rules');
const plain = await tool.execute({});
if (!plain.rules || plain.rules.length < 500) throw new Error('规则文件没读到或太短');
if (plain.rules.includes('{{')) throw new Error('占位符没被替换');
if ('error' in plain) throw new Error('读取成功时不该有 error 字段（会触发无损 JSON 校验失败）');
console.log('规则字数 =', plain.rules.length, '| 权重 =', JSON.stringify(plain.weights));

const scored = await tool.execute({ metrics: { steadyErr: 1.2, riseMs: 46, ripple: 2.2, swing: 5.6 } });
console.log('\n打分（好的一组）=', scored.score, '|', scored.verdict);
const bad = await tool.execute({ metrics: { steadyErr: 58, riseMs: 900, ripple: 25, swing: 60 } });
console.log('打分（差的一组）=', bad.score, '|', bad.verdict);
if (!(scored.score > bad.score)) throw new Error('好的一组居然不比差的分数高');

const rendered = tool.output.render({}, plain).map((p) => p.type).join(',');
console.log('render 段 =', rendered);
if (rendered.includes('image')) throw new Error('render 里出现 image');

// -- 改权重 / 关掉卡片，调参卡要跟着变 --
const settingsFile = path.join(process.env.DSH_HOME, 'autopid', 'settings.json');
fs.mkdirSync(path.dirname(settingsFile), { recursive: true });

fs.writeFileSync(settingsFile, JSON.stringify({ tuneKpOsc: 100, tuneKiOsc: 0, tuneSpeed: 0, tuneSteady: 0 }), 'utf8');
apply(ctx, {});
const tool2 = tools.get('autopid_tuning_rules');
const reWeighted = await tool2.execute({ metrics: { steadyErr: 0, riseMs: 0, ripple: 50, swing: 0 } });
console.log('抖动权重 100 时，纹波 50% 的分数 =', reWeighted.score, '|', reWeighted.verdict);
if (reWeighted.score >= 60) throw new Error('权重 100 时纹波 50% 不应该还能得高分');
if (!cardOf().includes('Kp 抖动 100')) throw new Error('改了权重，调参卡没跟着变');

// -- 卡是文件：改文件就要立刻反映到注入内容 --
const cardFile = path.join(process.env.DSH_HOME, 'my-card.md');
fs.writeFileSync(cardFile, '【我的卡】目标 {{kpOsc}} / 保守 {{kiOsc}}', 'utf8');
fs.writeFileSync(settingsFile, JSON.stringify({ tuningCardPath: cardFile, tuneKpOsc: 77, tuneKiOsc: 11 }), 'utf8');
apply(ctx, {});
const custom = cardOf();
if (!custom.includes('【我的卡】目标 77 / 保守 11')) throw new Error(`自定义卡没生效，收到：${custom}`);
console.log('自定义卡文件生效：', custom);

fs.writeFileSync(settingsFile, JSON.stringify({ tuningCard: false }), 'utf8');
apply(ctx, {});
if (cardOf() !== '') throw new Error('tuningCard=false 时卡片应该是空字符串');
console.log('tuningCard=false 时卡片为空，符合预期');

console.log('\nOK');
