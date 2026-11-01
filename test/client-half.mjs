// 验证 Client 那半：把 __ModuleLoader__ 的 load 截下来，跑一遍 apply，
// 看它有没有把「设置 → 插件」那个 tab 正确注册上去。
// 不渲染 React —— 只验装配（id、slot 名、tab 标签），渲染留给真页面。
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

let captured = null;
globalThis.window = {
  __ModuleLoader__: {
    load(def) {
      captured = def;
    },
  },
};

await import(pathToFileURL(path.join(ROOT, 'client.js')).href);

check('模块注册了', captured !== null, captured?.id ?? '(none)');
check('id 与包名一致', captured?.id === 'dsh-autopid', String(captured?.id));

// 足够让 factory 跑起来的 React 替身（不渲染，只给 require 用）
const fakeReact = {
  createElement: (...args) => ({ type: 'el', args }),
  useState: (v) => [v, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useSyncExternalStore: () => 0,
  Fragment: 'Fragment',
};

const mod = captured.factory((id) => (id === 'react' ? fakeReact : {}));
check('导出 inject', Array.isArray(mod?.inject) && mod.inject.includes('slots') && mod.inject.includes('locale'),
  JSON.stringify(mod?.inject));

const tabs = [];
const locales = [];
const slots = {
  inject: (owner, cb) => {
    cb();
    return () => {};
  },
  register: (config, view) => {
    tabs.push({ config, view });
    return () => {};
  },
};

mod.apply({
  effect: (fn) => {
    fn();
    return () => {};
  },
  slots,
  locale: {
    register: (ns, lang, dict) => {
      locales.push({ ns, lang, keys: Object.keys(dict).length });
      return () => {};
    },
    bind: (ns) => (key) => (key === 'tab' ? '自动调参' : key),
  },
});

check('注册了 zh/en 两套文案', locales.length === 2, JSON.stringify(locales.map((l) => `${l.lang}:${l.keys}`)));
check('挂在 settings.plugins.tab', tabs.length === 1 && tabs[0].config.name === 'settings.plugins.tab',
  tabs[0]?.config?.name ?? '(none)');
check('tab id 正确', tabs[0]?.config?.id === 'dsh-autopid', String(tabs[0]?.config?.id));
check('tab 有标签函数', typeof tabs[0]?.config?.label === 'function' && tabs[0].config.label() === '自动调参',
  String(tabs[0]?.config?.label?.()));
check('tab 有视图组件', typeof tabs[0]?.view === 'function', typeof tabs[0]?.view);

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} 通过`);
process.exit(failed.length ? 1 : 0);
