/**
 * dsh-autoPID —— Client 半边（Web 页面那一半）。
 *
 * 在「设置 → 插件 → 自动调参」里挂一个面板：
 *   ① 串口控制（选口 / 波特率 / 打开 / 关闭）
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
        close: '关闭',
        window: '时间窗',
        normalize: '各自归一化',
        channels: '通道',
        channelsHint: '留空=全部，例如 0,1',
        noPorts: '没找到串口（单片机插上了再点刷新）',
        connecting: '正在连桥…',
        connected: '已连接',
        disconnected: '未连接',
        simulating: '模拟数据中',
        idle: '空缓冲',
        points: '缓冲 {n} 点',
        chans: '{n} 通道',
        age: '最新 {n}s 前',
        noData: '还没有数据：选个串口点「打开」。没有硬件时可以用 autopid_open 的 simulate 让模型那边出一路假数据。',
        bridgeDown: '桥没起来：{error}',
        params: '参数下发',
        noParams: '配置里没写参数名（paramNames 是空的），先去插件配置里填',
        badNumbers: '输入的参数里有没有数字的项',
        commands: '运行控制',
        start: '启动',
        stop: '停止',
        reset: '重来',
        cmdHelp: '这三条指令的正文在插件配置里改（cmdStart / cmdStop / cmdReset），想发什么都行。',
        csvLine: 'CSV：{path}',
        configTitle: '配置（在这里改，不用动文件）',
        csvPathLabel: 'CSV 落盘路径（空 = 不落盘）',
        channelsLabel: '通道数（0 = 自动）',
        channelNamesLabel: '通道名（逗号分隔）',
        paramNamesLabel: '参数名（逗号分隔，顺序=数值顺序）',
        setFormatLabel: '下发格式',
        tuneTitle: '调参关注度（AI 按这些权重挑参数）',
        tuneKpOscLabel: 'Kp 抖动',
        tuneKiOscLabel: 'Ki 摆动',
        tuneSpeedLabel: '响应速度',
        tuneSteadyLabel: '稳态均值',
        tuneHint: '数值越大越在意这一项。规则写在插件目录的 rules/tuning-rules.md，AI 调参前会先读它。',
        save: '保存',
        saving: '保存中…',
        saved: '存好了，已经生效',
        saveFail: '没存上',
        configHint: '保存后立刻写进设置文件，并同步给串口桥，不用重启。这些字段和 DSH 设置页那份表单是同一套配置。',
        configFile: '设置文件：{path}',
        csvOff: '没配（不落盘；在插件配置的 csvPath 里填绝对路径）',
        chanLine: '通道：{n} 路（{names}）',
        chanAuto: '配置里没写通道名',
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
        close: 'Close',
        window: 'Window',
        normalize: 'Normalize',
        channels: 'Channels',
        channelsHint: 'Empty = all, e.g. 0,1',
        noPorts: 'No serial ports found (plug the board in, then refresh)',
        connecting: 'Connecting…',
        connected: 'Connected',
        disconnected: 'Not connected',
        simulating: 'Simulating',
        idle: 'Empty buffer',
        points: '{n} points',
        chans: '{n} ch',
        age: 'newest {n}s ago',
        noData: 'No data yet: pick a port and press Open. Without hardware, ask the agent for autopid_open simulate.',
        bridgeDown: 'Bridge is down: {error}',
        params: 'Parameters',
        noParams: 'No parameter names configured (paramNames is empty). Fill it in the plugin config first.',
        badNumbers: 'Some parameter is not a number',
        commands: 'Run control',
        start: 'Start',
        stop: 'Stop',
        reset: 'Reset',
        cmdHelp: 'The texts come from the plugin config (cmdStart / cmdStop / cmdReset); anything works.',
        csvLine: 'CSV: {path}',
        configTitle: 'Settings (edit here; no files needed)',
        csvPathLabel: 'CSV output path (empty = off)',
        channelsLabel: 'Channels (0 = auto)',
        channelNamesLabel: 'Channel names (comma separated)',
        paramNamesLabel: 'Parameter names (comma separated, order = value order)',
        setFormatLabel: 'Send format',
        tuneTitle: 'Tuning focus (the AI picks gains by these weights)',
        tuneKpOscLabel: 'Kp ripple',
        tuneKiOscLabel: 'Ki swing',
        tuneSpeedLabel: 'Response',
        tuneSteadyLabel: 'Steady value',
        tuneHint: 'Higher = care more. The rules live in rules/tuning-rules.md inside the plugin; the AI reads them before tuning.',
        save: 'Save',
        saving: 'Saving…',
        saved: 'Saved and applied',
        saveFail: 'Save failed',
        configHint: 'Saved to the settings file and pushed to the bridge immediately; no restart needed. Same config as the DSH settings form.',
        configFile: 'Settings file: {path}',
        csvOff: 'not configured (no CSV file; set csvPath in the plugin config)',
        chanLine: 'Channels: {n} ({names})',
        chanAuto: 'no channel names configured',
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
.ap-grid{display:flex;gap:10px;flex-wrap:wrap}
.ap-field{display:flex;flex-direction:column;gap:4px;min-width:150px;flex:1 1 150px}
.ap-field.wide{flex:1 1 320px}
.ap-field .ap-label{white-space:nowrap}
.ap-details{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:10px 14px}
.ap-details>summary{cursor:pointer;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}
.ap-details[open]>summary{margin-bottom:10px}
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
      const [portError, setPortError] = React.useState('');
      const [port, setPort] = React.useState('');
      const [baud, setBaud] = React.useState(115200);
      // 参数名和个数由配置决定（param_names），界面跟着它长
      const [cfgInfo, setCfgInfo] = React.useState(null);
      const [values, setValues] = React.useState([]);
      // 图形化配置：draft 是正在编辑的那份，settings 是已经存下来的那份
      const [settings, setSettings] = React.useState(null);
      const [draft, setDraft] = React.useState(null);
      const [saveMsg, setSaveMsg] = React.useState(null);
      const [settingsFile, setSettingsFile] = React.useState('');

      const loadSettings = React.useCallback(async () => {
        try {
          const json = await getJson('/settings');
          if (json?.ok === false) {
            setSaveMsg({ ok: false, text: String(json.error ?? '读设置失败') });
            return;
          }
          setSettings(json.config ?? null);
          setSettingsFile(String(json.file ?? ''));
          setDraft((prev) => prev ?? { ...(json.config ?? {}) });
        } catch (error) {
          setSaveMsg({ ok: false, text: String(error?.message ?? error) });
        }
      }, []);

      const paramNames = React.useMemo(
        () => (Array.isArray(cfgInfo?.param_names) ? cfgInfo.param_names : []),
        [cfgInfo],
      );

      const loadConfig = React.useCallback(async () => {
        try {
          const json = await getJson('/config');
          if (json?.ok === false) {
            setResult({ ok: false, error: String(json.error ?? '读配置失败') });
            return;
          }
          setCfgInfo(json);
          // 参数个数变了才重置输入框，别每秒钟都把用户输的数字清掉
          setValues((prev) => {
            const n = Array.isArray(json?.param_names) ? json.param_names.length : 0;
            if (prev.length === n) return prev;
            const next = new Array(n).fill('');
            for (let i = 0; i < Math.min(n, prev.length); i += 1) next[i] = prev[i];
            return next;
          });
        } catch (error) {
          setResult({ ok: false, error: String(error?.message ?? error) });
        }
      }, []);

      const status = snap?.ok === false ? null : snap?.status ?? null;
      const reachable = snap?.ok !== false;
      const connected = Boolean(status?.connected);
      const simulating = Boolean(status?.simulate || status?.mode === 'simulate');
      const buffer = Number(status?.buffer ?? 0);
      const chanCount = Number(status?.channels ?? 0);

      // 串口清单：桥刚起来那次查询很容易撞上"还没监听完"，所以失败要重试几次。
      // 关键是"没查到"和"确实没有"要分开说 —— 空着不解释，人只会以为没插板子。
      const loadPorts = React.useCallback(async () => {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            const json = await getJson('/ports');
            const list = Array.isArray(json?.ports) ? json.ports : [];
            setPorts(list);
            setPortError(String(json?.error ?? ''));
            if (list.length && !port) setPort(list[0].device);
            return;
          } catch (error) {
            if (attempt === 2) {
              setPorts([]);
              setPortError(String(error?.message ?? error));
            } else {
              await new Promise((r) => setTimeout(r, 700));
            }
          }
        }
      }, [port]);

      // 进面板先摸一次串口清单和配置；第一次拿不到就等用户点刷新。
      React.useEffect(() => {
        if (ports === null) void loadPorts();
        if (cfgInfo === null) void loadConfig();
        if (settings === null) void loadSettings();
        if (status?.port && !port) setPort(String(status.port));
        if (status?.baud) setBaud(Number(status.baud));
      }, [ports, cfgInfo, settings, status?.port, status?.baud]); // eslint-disable-line react-hooks/exhaustive-deps

      const setField = (key, value) => {
        setDraft((prev) => ({ ...(prev ?? {}), [key]: value }));
      };

      const saveSettingsDraft = () => {
        if (!draft) return;
        setBusy('save-settings');
        setSaveMsg(null);
        void postJson('/settings', {
          csvPath: draft.csvPath,
          channels: draft.channels,
          channelNames: draft.channelNames,
          paramNames: draft.paramNames,
          setFormat: draft.setFormat,
          cmdStart: draft.cmdStart,
          cmdStop: draft.cmdStop,
          cmdReset: draft.cmdReset,
          tuneKpOsc: draft.tuneKpOsc,
          tuneKiOsc: draft.tuneKiOsc,
          tuneSpeed: draft.tuneSpeed,
          tuneSteady: draft.tuneSteady,
        })
          .then((r) => {
            if (r?.ok) {
              setSettings(r.config ?? null);
              setDraft({ ...(r.config ?? {}) });
              setSaveMsg({ ok: true, text: t('saved') });
              // 参数名/通道名改了，上面那块要跟着变
              void loadConfig();
            } else {
              setSaveMsg({ ok: false, text: String(r?.error ?? t('saveFail')) });
            }
          })
          .catch((error) => setSaveMsg({ ok: false, text: String(error?.message ?? error) }))
          .finally(() => setBusy(null));
      };

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

      const closePort = () => {
        run('close', postJson('/close', {}).then((r) => setResult(r)));
      };

      const sendParams = () => {
        const nums = values.map((x) => Number(x));
        if (!nums.length) {
          setResult({ ok: false, error: t('noParams') });
          return;
        }
        if (nums.some((x) => !Number.isFinite(x))) {
          setResult({ ok: false, error: t('badNumbers') });
          return;
        }
        run('send', postJson('/set', { values: nums }).then((r) => setResult(r)));
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
            }, ports === null
              ? h('option', { key: 'wait', value: '' }, t('connecting'))
              : ports.length === 0
                ? h('option', { key: 'none', value: '' }, t('noPorts'))
                : ports.map((p) => h('option', { key: p.device, value: p.device },
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
          // 查询失败的原因要露出来：空列表 + 一句"没找到串口"分不清是没插板子还是桥没起来。
          portError
            ? h('div', { key: 'portError', className: 'ap-warn' }, portError)
            : null,
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
            ...paramNames.map((name, index) => h('span', { key: `l${index}`, className: 'ap-label' }, name)),
            ...paramNames.map((name, index) => h('input', {
              key: `v${index}`,
              className: 'ap-input tiny',
              type: 'text',
              value: values[index] ?? '',
              placeholder: '0',
              'aria-label': name,
              onChange: (e) => {
                const next = [...values];
                next[index] = e.target.value;
                setValues(next);
              },
            })),
            h('button', {
              key: 'send',
              type: 'button',
              className: 'ap-btn primary',
              disabled: busy !== null || paramNames.length === 0,
              onClick: sendParams,
            }, busy === 'send' ? t('sending') : t('send')),
          ]),
          paramNames.length === 0
            ? h('div', { key: 'noParams', className: 'ap-warn' }, t('noParams'))
            : null,
          h('div', { key: 'help', className: 'ap-hint' }, t('help')),
        ]),

        h('div', { key: 'cmd', className: 'ap-card' }, [
          h('div', { key: 'row', className: 'ap-row' }, [
            h('span', { key: 'title', className: 'ap-label' }, t('commands')),
            ...['start', 'stop', 'reset'].map((action) => h('button', {
              key: action,
              type: 'button',
              className: action === 'start' ? 'ap-btn primary' : 'ap-btn',
              disabled: busy !== null,
              onClick: () => run(`cmd-${action}`, postJson('/command', { action }).then((r) => setResult(r))),
              title: String(cfgInfo?.[`cmd_${action}`] ?? ''),
            }, busy === `cmd-${action}` ? '…' : t(action))),
          ]),
          h('div', { key: 'help', className: 'ap-hint' }, t('cmdHelp')),
        ]),

        h('details', { key: 'cfg', className: 'ap-details', open: true }, [
          h('summary', { key: 'sum' }, t('configTitle')),
          h('div', { key: 'body', style: { display: 'flex', flexDirection: 'column', gap: '10px' } }, [
            h('div', { key: 'grid1', className: 'ap-grid' }, [
              h('label', { key: 'csv', className: 'ap-field wide' }, [
                h('span', { key: 'l', className: 'ap-label' }, t('csvPathLabel')),
                h('input', {
                  key: 'i',
                  className: 'ap-input',
                  type: 'text',
                  value: draft?.csvPath ?? '',
                  placeholder: 'C:\\\\data\\\\pid.csv',
                  onChange: (e) => setField('csvPath', e.target.value),
                }),
              ]),
              h('label', { key: 'ch', className: 'ap-field' }, [
                h('span', { key: 'l', className: 'ap-label' }, t('channelsLabel')),
                h('input', {
                  key: 'i',
                  className: 'ap-input',
                  type: 'number',
                  min: 0,
                  max: 64,
                  value: draft?.channels ?? 0,
                  onChange: (e) => setField('channels', Number(e.target.value) || 0),
                }),
              ]),
            ]),
            h('div', { key: 'grid2', className: 'ap-grid' }, [
              h('label', { key: 'cn', className: 'ap-field wide' }, [
                h('span', { key: 'l', className: 'ap-label' }, t('channelNamesLabel')),
                h('input', {
                  key: 'i',
                  className: 'ap-input',
                  type: 'text',
                  value: draft?.channelNames ?? '',
                  placeholder: 'L,R,PL,PR',
                  onChange: (e) => setField('channelNames', e.target.value),
                }),
              ]),
              h('label', { key: 'pn', className: 'ap-field wide' }, [
                h('span', { key: 'l', className: 'ap-label' }, t('paramNamesLabel')),
                h('input', {
                  key: 'i',
                  className: 'ap-input',
                  type: 'text',
                  value: draft?.paramNames ?? '',
                  placeholder: 'kp,ki,kd',
                  onChange: (e) => setField('paramNames', e.target.value),
                }),
              ]),
              h('label', { key: 'sf', className: 'ap-field' }, [
                h('span', { key: 'l', className: 'ap-label' }, t('setFormatLabel')),
                h('select', {
                  key: 'i',
                  className: 'ap-select',
                  value: draft?.setFormat ?? 'positional',
                  onChange: (e) => setField('setFormat', e.target.value),
                }, [
                  h('option', { key: 'p', value: 'positional' }, 'SET 1.2 0.03 0.3'),
                  h('option', { key: 'n', value: 'named' }, 'SET kp=1.2 ki=0.03 kd=0.3'),
                ]),
              ]),
            ]),
            h('div', { key: 'grid3', className: 'ap-grid' }, [
              h('label', { key: 'c1', className: 'ap-field' }, [
                h('span', { key: 'l', className: 'ap-label' }, t('start')),
                h('input', {
                  key: 'i', className: 'ap-input', type: 'text',
                  value: draft?.cmdStart ?? '',
                  onChange: (e) => setField('cmdStart', e.target.value),
                }),
              ]),
              h('label', { key: 'c2', className: 'ap-field' }, [
                h('span', { key: 'l', className: 'ap-label' }, t('stop')),
                h('input', {
                  key: 'i', className: 'ap-input', type: 'text',
                  value: draft?.cmdStop ?? '',
                  onChange: (e) => setField('cmdStop', e.target.value),
                }),
              ]),
              h('label', { key: 'c3', className: 'ap-field' }, [
                h('span', { key: 'l', className: 'ap-label' }, t('reset')),
                h('input', {
                  key: 'i', className: 'ap-input', type: 'text',
                  value: draft?.cmdReset ?? '',
                  onChange: (e) => setField('cmdReset', e.target.value),
                }),
              ]),
            ]),
            h('div', { key: 'tuneTitle', className: 'ap-label', style: { marginTop: '4px' } }, t('tuneTitle')),
            h('div', { key: 'grid4', className: 'ap-grid' }, [
              ['tuneKpOsc', 'tuneKpOscLabel'],
              ['tuneKiOsc', 'tuneKiOscLabel'],
              ['tuneSpeed', 'tuneSpeedLabel'],
              ['tuneSteady', 'tuneSteadyLabel'],
            ].map(([key, labelKey]) => h('label', { key, className: 'ap-field' }, [
              h('span', { key: 'l', className: 'ap-label' }, `${t(labelKey)}：${draft?.[key] ?? 0}`),
              h('input', {
                key: 'i',
                className: 'ap-input',
                type: 'range',
                min: 0,
                max: 100,
                step: 5,
                value: draft?.[key] ?? 0,
                onChange: (e) => setField(key, Number(e.target.value) || 0),
              }),
            ]))),
            h('div', { key: 'tuneHint', className: 'ap-hint' }, t('tuneHint')),
            h('div', { key: 'actions', className: 'ap-row' }, [
              h('button', {
                key: 'save',
                type: 'button',
                className: 'ap-btn primary',
                disabled: busy !== null || draft === null,
                onClick: saveSettingsDraft,
              }, busy === 'save-settings' ? t('saving') : t('save')),
              saveMsg
                ? h('span', { key: 'msg', className: saveMsg.ok ? 'ap-ok' : 'ap-warn' }, saveMsg.text)
                : null,
            ]),
            h('div', { key: 'hint', className: 'ap-hint' }, t('configHint')),
            settingsFile
              ? h('div', { key: 'file', className: 'ap-foot' }, t('configFile').replace('{path}', settingsFile))
              : null,
          ]),
        ]),

        h('div', { key: 'foot', className: 'ap-foot' }, [
          h('span', { key: 'f1', style: { display: 'block' } }, t('csvLine').replace('{path}', cfgInfo?.csv_path ? String(cfgInfo.csv_path) : t('csvOff'))),
          h('span', { key: 'f2', style: { display: 'block' } },
            t('chanLine')
              .replace('{n}', String(cfgInfo?.channels || 0))
              .replace('{names}', (cfgInfo?.channel_names ?? []).join(' / ') || t('chanAuto'))),
          h('span', { key: 'f3' }, t('hint')),
        ]),
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
