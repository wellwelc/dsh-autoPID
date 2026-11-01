/**
 * dsh-autoPID —— Client 半边（Web 页面那一半）。
 *
 * 在「设置 → 插件 → 自动调参」里挂一个面板：
 *   ① 串口控制（选口 / 波特率 / 打开 / 模拟数据 / 关闭）
 *   ② 实时波形（PNG 每秒重取一次，走 Host 的同源路由，不直连桥的端口）
 *   ③ 参数下发（kp / ki / kd → "SET ..."）
 *
 * 为什么波形走 Host 路由而不是直接 <img src="http://127.0.0.1:8765/plot">：
 * 桥的端口是配置项，随时可能改；同源路由由 Host 去问桥，页面这边永远只认
 * `/api/autopid/*`，端口换了页面不用动。
 *
 * 不 import 任何 Harness 的 Client 包：React 从浏览器模块表拿，
 * 样式只用 --dsw-alias-* 主题变量，控件自己写。
 */

window.__ModuleLoader__.load({
  id: 'dsh-autopid',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'autopid';
    const API = '/api/autopid';
    const POLL_MS = 1000;

    const DICT = {
      zh: {
        tab: '自动调参',
        title: '串口波形 · PID 调参',
        sub: '波形每秒刷新；串口由 Python 桥持有，DSH 不直接碰串口。',
        refresh: '刷新',
        pause: '暂停',
        resume: '继续',
        port: '串口',
        baud: '波特率',
        open: '打开',
        simulate: '模拟数据',
        close: '关闭',
        window: '时间窗',
        normalize: '各自归一化',
        channels: '通道',
        channelsHint: '留空=全部，例如 0,1',
        noPorts: '没找到串口（单片机插上了再点刷新）',
        connected: '已连接',
        disconnected: '未连接',
        simulating: '模拟数据中',
        idle: '空缓冲',
        points: '缓冲 {n} 点',
        chans: '{n} 通道',
        age: '最新 {n}s 前',
        noData: '还没有数据：选个串口点「打开」，或者点「模拟数据」先看看出图效果。',
        bridgeDown: '桥没起来：{error}',
        params: '参数下发',
        kp: 'kp',
        ki: 'ki',
        kd: 'kd',
        send: '下发',
        sending: '下发中…',
        sent: '{text}',
        sendFail: '没发出去：{error}',
        help: '下发格式是文本 "SET kp ki kd"，单片机那边要自己实现接收解析。',
        hint: '画图与统计的接口同时给模型用（autopid_plot / autopid_stats）。',
      },
      en: {
        tab: 'AutoPID',
        title: 'Serial waveform · PID tuning',
        sub: 'Refreshes every second. The Python bridge owns the serial port; DSH never opens it.',
        refresh: 'Refresh',
        pause: 'Pause',
        resume: 'Resume',
        port: 'Port',
        baud: 'Baud',
        open: 'Open',
        simulate: 'Simulate',
        close: 'Close',
        window: 'Window',
        normalize: 'Normalize',
        channels: 'Channels',
        channelsHint: 'Empty = all, e.g. 0,1',
        noPorts: 'No serial ports found (plug the board in, then refresh)',
        connected: 'Connected',
        disconnected: 'Not connected',
        simulating: 'Simulating',
        idle: 'Empty buffer',
        points: '{n} points',
        chans: '{n} ch',
        age: 'newest {n}s ago',
        noData: 'No data yet: pick a port and press Open, or press Simulate to see a demo waveform.',
        bridgeDown: 'Bridge is down: {error}',
        params: 'Parameters',
        kp: 'kp',
        ki: 'ki',
        kd: 'kd',
        send: 'Send',
        sending: 'Sending…',
        sent: '{text}',
        sendFail: 'Not sent: {error}',
        help: 'Sent as the plain text "SET kp ki kd"; the firmware must parse it.',
        hint: 'The same endpoints back the agent tools autopid_plot / autopid_stats.',
      },
    };

    const CSS = `
.ap-wrap{display:flex;flex-direction:column;gap:14px;padding:4px 0 24px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5}
.ap-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.ap-title{font-size:15px;font-weight:600}
.ap-actions{margin-left:auto;display:flex;gap:8px}
.ap-btn{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:8px;padding:4px 10px;font:inherit;font-size:12px;cursor:pointer}
.ap-btn:hover{border-color:var(--dsw-alias-border-l2)}
.ap-btn:disabled{opacity:.55;cursor:default}
.ap-btn.primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:#fff}
.ap-badge{display:inline-flex;align-items:center;gap:6px;padding:0 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:20px;white-space:nowrap}
.ap-badge .dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-idle-primary)}
.ap-badge.live .dot{background:var(--dsw-alias-state-success-primary)}
.ap-badge.sim .dot{background:var(--dsw-alias-brand-primary)}
.ap-card{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;padding:12px 14px;background:var(--dsw-alias-bg-layer-1);display:flex;flex-direction:column;gap:10px}
.ap-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.ap-label{color:var(--dsw-alias-label-secondary);font-size:12px}
.ap-select,.ap-input{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;padding:4px 8px;min-width:0}
.ap-input.narrow{width:84px}
.ap-input.tiny{width:64px}
.ap-check{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer}
.ap-shot{display:block;width:100%;height:auto;border-radius:10px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2)}
.ap-empty{color:var(--dsw-alias-label-secondary);font-size:12px;padding:28px 12px;text-align:center;border:1px dashed var(--dsw-alias-border-l1);border-radius:10px}
.ap-hint{color:var(--dsw-alias-label-secondary);font-size:12px}
.ap-warn{color:var(--dsw-alias-state-error-primary);font-size:12px}
.ap-ok{color:var(--dsw-alias-state-success-primary);font-size:12px}
.ap-foot{color:var(--dsw-alias-label-secondary);font-size:11px}
`;

    // ── 共享状态：面板可能开开关关，轮询只留一份 ──────────────────
    const shared = { state: null, subs: new Set(), timer: null, seq: 0 };

    function notify() {
      for (const fn of shared.subs) {
        try {
          fn();
        } catch {
          // 一个订阅者坏掉不影响别人
        }
      }
    }

    async function getJson(path) {
      const res = await fetch(API + path, { headers: { Accept: 'application/json' } });
      return res.json();
    }

    async function postJson(path, body) {
      const res = await fetch(API + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body ?? {}),
      });
      return res.json();
    }

    async function loadState() {
      try {
        const json = await getJson('/state');
        shared.state = json && typeof json === 'object' ? json : { ok: false, error: '空响应' };
      } catch (error) {
        shared.state = { ok: false, error: String(error?.message ?? error) };
      }
      shared.seq += 1;
      notify();
    }

    function useAutoPid() {
      const [snapshot, setSnapshot] = React.useState(shared.state);
      React.useEffect(() => {
        const sync = () => setSnapshot(shared.state);
        shared.subs.add(sync);
        if (shared.timer === null) {
          notify();
          void loadState();
          shared.timer = setInterval(() => {
            if (shared.subs.size === 0) return;
            void loadState();
          }, POLL_MS);
        }
        return () => {
          shared.subs.delete(sync);
          if (shared.subs.size === 0 && shared.timer !== null) {
            clearInterval(shared.timer);
            shared.timer = null;
          }
        };
      }, []);
      return snapshot;
    }

    function useLocale(locale) {
      React.useSyncExternalStore(
        React.useCallback((cb) => locale.subscribe(cb), [locale]),
        () => locale.getSnapshot().revision,
        () => locale.getSnapshot().revision,
      );
      return locale.bind(NS);
    }

    // ── 面板 ────────────────────────────────────────────────────
    function AutoPidPanel({ locale }) {
      const t = useLocale(locale);
      const snap = useAutoPid();
      const [busy, setBusy] = React.useState(null);
      const [result, setResult] = React.useState(null);
      const [paused, setPaused] = React.useState(false);
      const [win, setWin] = React.useState(10);
      const [normalize, setNormalize] = React.useState(false);
      const [channels, setChannels] = React.useState('');
      const [ports, setPorts] = React.useState(null);
      const [port, setPort] = React.useState('');
      const [baud, setBaud] = React.useState(115200);
      const [kp, setKp] = React.useState('1.20');
      const [ki, setKi] = React.useState('0.03');
      const [kd, setKd] = React.useState('0.30');

      const status = snap?.ok === false ? null : snap?.status ?? null;
      const reachable = snap?.ok !== false;
      const connected = Boolean(status?.connected);
      const simulating = Boolean(status?.simulate || status?.mode === 'simulate');
      const buffer = Number(status?.buffer ?? 0);
      const chanCount = Number(status?.channels ?? 0);

      const loadPorts = React.useCallback(async () => {
        try {
          const json = await getJson('/ports');
          const list = Array.isArray(json?.ports) ? json.ports : [];
          setPorts(list);
          if (list.length && !port) setPort(list[0].device);
        } catch {
          setPorts([]);
        }
      }, [port]);

      // 进面板先摸一次串口清单；第一次拿不到就等用户点刷新。
      React.useEffect(() => {
        if (ports === null) void loadPorts();
        if (status?.port && !port) setPort(String(status.port));
        if (status?.baud) setBaud(Number(status.baud));
      }, [ports, status?.port, status?.baud]); // eslint-disable-line react-hooks/exhaustive-deps

      const run = (kind, task) => {
        setBusy(kind);
        void task
          .catch((error) => setResult({ ok: false, error: String(error?.message ?? error) }))
          .finally(() => {
            setBusy(null);
            void loadState();
          });
      };

      const openPort = () => {
        if (!port) {
          setResult({ ok: false, error: t('noPorts') });
          return;
        }
        run('open', postJson('/open', { port, baud: Number(baud) || 115200 }).then((r) => {
          setResult(r);
          if (r?.ok) void loadPorts();
        }));
      };

      const openSimulate = () => {
        run('sim', postJson('/open', { simulate: true }).then((r) => setResult(r)));
      };

      const closePort = () => {
        run('close', postJson('/close', {}).then((r) => setResult(r)));
      };

      const sendParams = () => {
        const values = [kp, ki, kd].map((x) => Number(x)).filter((x) => Number.isFinite(x));
        if (!values.length) {
          setResult({ ok: false, error: '三个参数都不像数字' });
          return;
        }
        run('send', postJson('/set', { values }).then((r) => setResult(r)));
      };

      // 时间窗 / 归一化 / 通道变了就换一张图；暂停时连 t 都不动。
      // 每秒重画一张，所以固定要小一号的尺寸 —— 1400×700 的默认值是给模型出图用的。
      const query = [
        `window=${encodeURIComponent(String(win))}`,
        `norm=${normalize ? 1 : 0}`,
        'width=1100',
        'height=460',
        channels.trim() ? `ch=${encodeURIComponent(channels.trim())}` : '',
        `t=${paused ? 'paused' : shared.seq}`,
      ].filter(Boolean).join('&');

      const shotSrc = `${API}/plot.png?${query}`;

      const badgeClass = `ap-badge${simulating ? ' sim' : connected ? ' live' : ''}`;
      const badgeText = !reachable
        ? t('bridgeDown').replace('{error}', String(snap?.error ?? ''))
        : simulating
          ? t('simulating')
          : connected
            ? t('connected')
            : t('disconnected');

      const statLine = [
        buffer > 0 ? t('points').replace('{n}', String(buffer)) : t('idle'),
        chanCount > 0 ? t('chans').replace('{n}', String(chanCount)) : '',
        status?.newest_age != null ? t('age').replace('{n}', String(status.newest_age)) : '',
      ].filter(Boolean).join(' · ');

      return h('div', { className: 'ap-wrap' }, [
        h('style', { key: 'style' }, CSS),
        h('div', { key: 'head', className: 'ap-head' }, [
          h('span', { key: 'title', className: 'ap-title' }, t('title')),
          h('span', { key: 'badge', className: badgeClass }, [
            h('span', { key: 'dot', className: 'dot', 'aria-hidden': true }),
            h('span', { key: 'text' }, badgeText),
          ]),
          h('div', { key: 'actions', className: 'ap-actions' }, [
            h('button', {
              key: 'pause',
              type: 'button',
              className: 'ap-btn',
              onClick: () => setPaused((v) => !v),
            }, paused ? t('resume') : t('pause')),
            h('button', {
              key: 'refresh',
              type: 'button',
              className: 'ap-btn',
              disabled: busy !== null,
              onClick: () => {
                void loadState();
                void loadPorts();
              },
            }, busy === 'refresh' ? '…' : t('refresh')),
          ]),
        ]),
        h('div', { key: 'sub', className: 'ap-hint' }, t('sub')),

        h('div', { key: 'ctl', className: 'ap-card' }, [
          h('div', { key: 'row1', className: 'ap-row' }, [
            h('span', { key: 'l1', className: 'ap-label' }, t('port')),
            h('select', {
              key: 'port',
              className: 'ap-select',
              value: port,
              onChange: (e) => setPort(e.target.value),
            }, (ports ?? []).length === 0
              ? h('option', { key: 'none', value: '' }, t('noPorts'))
              : (ports ?? []).map((p) => h('option', { key: p.device, value: p.device },
                p.desc && p.desc !== 'n/a' ? `${p.device} · ${p.desc}` : p.device))),
            h('span', { key: 'l2', className: 'ap-label' }, t('baud')),
            h('input', {
              key: 'baud',
              className: 'ap-input narrow',
              type: 'number',
              min: 1200,
              step: 1,
              value: baud,
              onChange: (e) => setBaud(Number(e.target.value) || 0),
            }),
            h('button', {
              key: 'open',
              type: 'button',
              className: 'ap-btn primary',
              disabled: busy !== null,
              onClick: openPort,
            }, busy === 'open' ? '…' : t('open')),
            h('button', {
              key: 'sim',
              type: 'button',
              className: 'ap-btn',
              disabled: busy !== null,
              onClick: openSimulate,
            }, busy === 'sim' ? '…' : t('simulate')),
            h('button', {
              key: 'close',
              type: 'button',
              className: 'ap-btn',
              disabled: busy !== null,
              onClick: closePort,
            }, busy === 'close' ? '…' : t('close')),
          ]),
          h('div', { key: 'row2', className: 'ap-row' }, [
            h('span', { key: 'l3', className: 'ap-label' }, t('window')),
            h('select', {
              key: 'win',
              className: 'ap-select',
              value: win,
              onChange: (e) => setWin(Number(e.target.value) || 10),
            }, [5, 10, 20, 30, 60, 120].map((s) => h('option', { key: s, value: s }, `${s}s`))),
            h('label', { key: 'norm', className: 'ap-check' }, [
              h('input', {
                key: 'cb',
                type: 'checkbox',
                checked: normalize,
                onChange: (e) => setNormalize(e.target.checked),
              }),
              h('span', { key: 'txt' }, t('normalize')),
            ]),
            h('span', { key: 'l4', className: 'ap-label' }, t('channels')),
            h('input', {
              key: 'ch',
              className: 'ap-input narrow',
              type: 'text',
              placeholder: t('channelsHint'),
              value: channels,
              onChange: (e) => setChannels(e.target.value),
            }),
            h('span', { key: 'stats', className: 'ap-hint' }, statLine),
          ]),
          result ? h('div', {
            key: 'result',
            className: result.ok ? 'ap-ok' : 'ap-warn',
          }, result.ok
            ? (result.sent ? t('sent').replace('{text}', String(result.sent)) : (result.mode ? String(result.mode) : '可以'))
            : t('sendFail').replace('{error}', String(result.error ?? '未知原因'))) : null,
        ]),

        h('div', { key: 'shot', className: 'ap-card' }, [
          buffer > 0 && reachable
            ? h('img', {
              key: 'img',
              className: 'ap-shot',
              src: shotSrc,
              alt: t('title'),
              'aria-label': t('title'),
            })
            : h('div', { key: 'empty', className: 'ap-empty' },
              reachable ? t('noData') : t('bridgeDown').replace('{error}', String(snap?.error ?? ''))),
        ]),

        h('div', { key: 'params', className: 'ap-card' }, [
          h('div', { key: 'row', className: 'ap-row' }, [
            h('span', { key: 'title', className: 'ap-label' }, t('params')),
            h('span', { key: 'l1', className: 'ap-label' }, t('kp')),
            h('input', {
              key: 'kp', className: 'ap-input tiny', type: 'text', value: kp,
              onChange: (e) => setKp(e.target.value),
            }),
            h('span', { key: 'l2', className: 'ap-label' }, t('ki')),
            h('input', {
              key: 'ki', className: 'ap-input tiny', type: 'text', value: ki,
              onChange: (e) => setKi(e.target.value),
            }),
            h('span', { key: 'l3', className: 'ap-label' }, t('kd')),
            h('input', {
              key: 'kd', className: 'ap-input tiny', type: 'text', value: kd,
              onChange: (e) => setKd(e.target.value),
            }),
            h('button', {
              key: 'send',
              type: 'button',
              className: 'ap-btn primary',
              disabled: busy !== null,
              onClick: sendParams,
            }, busy === 'send' ? t('sending') : t('send')),
          ]),
          h('div', { key: 'help', className: 'ap-hint' }, t('help')),
        ]),

        h('div', { key: 'foot', className: 'ap-foot' }, t('hint')),
      ]);
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => {
          const disposers = [
            ctx.locale.register(NS, 'zh', DICT.zh),
            ctx.locale.register(NS, 'en', DICT.en),
          ];
          return () => {
            for (const dispose of disposers) dispose();
          };
        });

        ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
          name: 'settings.plugins.tab',
          id: 'dsh-autopid',
          order: 72,
          label: () => ctx.locale.bind(NS)('tab'),
        }, () => h(AutoPidPanel, { locale: ctx.locale })));
      },
    };
  },
});
