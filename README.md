# dsh-autoPID

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 用的**串口波形图 + PID 调参**插件。

波形显示在 DSH 自己的界面里：**设置 → 插件 → 自动调参**。串口由 Python 桥独占，DSH 不碰串口。

```
单片机 ──printf──> 串口 ──> bridge.py(pyserial) ──┬──> CSV 落盘（模型读的就是它）
                                                 ├──> Host 路由 /api/autopid/* ──> 设置页里的实时波形
                                                 └──> 工具（统计、原始数据、出图、下发）
```

## 为什么这么设计

**串口不在 Node 里读**：DSH 跑在 Electron 里，`serialport` 是原生模块，要按 Electron 的 ABI 重新编译，换个 DSH 版本就容易挂。`pyserial` 是纯 Python，`pip install pyserial` 一次就完事。

**模型读的是落盘的 CSV，不是内存缓冲**：内存缓冲会滚动、会丢，也没法回头对数据。桥把每一行收到的数据追加进 `csvPath` 指定的文件（表头写了通道名），模型用 `autopid_samples` 直接读这份文件，也能传 `file` 读任意一份旧 CSV。没有配 CSV 时才退回读实时缓冲，回执里会写明来源。

**波形不再以图片塞进工具结果**（2026-11-01 踩过的坑）：工具结果的 `content` 里返回 `{type:'image'}` 会让**该会话之后每一次**请求在 20 毫秒内 `TRANSPORT` 失败，图永远留在历史里 → 会话永久作废（8 KB 小图也会触发）。所以现在：

- `autopid_plot` 只**落盘** PNG 并回文字路径，人自己打开看；
- 想**在界面里实时看**，去看设置页的「自动调参」面板 —— 它用 `<img>` 每秒重取一张，不进模型上下文。

**页面走 Host 同源路由，不直连桥的端口**：桥的端口是配置项、随时可能改；页面只认 `/api/autopid/*`，端口换了页面不用动（`cordis.patch.yml` 里 `httpPort` 改完重启即可）。

**通道数、参数名、指令正文都能改**：单片机那边的变量名和个数每个人都不同，写死在插件里迟早要改代码。这几项都在插件配置里（设置页可热改），桥支持 `POST /configure` 运行时更新，改完不用重启桥。

**选哪段让模型自己判断**：`autopid_stats` 给统计（峰峰值、振荡频率），模型据此决定画哪一段，再 `autopid_plot` 指定 `start/end` 出图。

## 可编辑的配置

| 字段 | 作用 |
|---|---|
| `csvPath` | 数据落盘到这个 `.csv`（绝对路径）；空 = 不落盘 |
| `channels` | 保留前几路数据；0 = 按第一行自动。配 2 就只存前 2 列 |
| `channelNames` | 通道名，逗号分隔（`L,R,PL,PR`），决定 CSV 表头和面板显示 |
| `paramNames` | 下发参数的名字和个数（`kp,ki,kd`），顺序就是数值顺序 |
| `setFormat` | `positional` → `SET 1.2 0.03 0.3`；`named` → `SET kp=1.2 ki=0.03 kd=0.3` |
| `cmdStart` / `cmdStop` / `cmdReset` | 「启动 / 停止 / 重来」三条指令的正文，想发什么文本都行 |

## 数据格式（单片机 printf 这一侧）

一行一组，`\r\n` 结尾，逗号分隔；桥收到的每一行会被加上时间戳写进 CSV：

```
单片机 printf:  30,28,1500,1500
CSV 里变成:     1793533217.971,30.000000,28.000000,1500.000000,1500.000000
表头:           t,左,右,PL,PR
```

带标签也认（`L:30,R:28` 会被拆出数字）；只要这一行里还有别的字符，数字仍按出现顺序取。

## 安装

1. 装 Python 依赖：

```bash
pip install pyserial pillow
```

2. 把本仓库 `link:` 进 DSH profile：

```bash
dsh plugin --profile desktop add link:<本仓库绝对路径>
```

或者直接改 `~/.dsh/profiles/desktop/package.json` 的 `dependencies` 加一行
`"dsh-autopid": "link:C:/path/to/dsh-autoPID"`，再把 `dsh-autopid` 加进
`dsh.profile.bundles`。

3. **重启 DSH**：Client 那一半是在启动时扫描 `dsh.client` 声明装配的，改完必须重启才看得到新面板。

4. 设置页里填串口名（如 `COM3`）和波特率，或者直接改 `cordis.patch.yml`。

## 设置页里的面板

- 串口：选口、改波特率、打开 / 关闭
- 时间窗：5 / 10 / 20 / 30 / 60 / 120 秒；可勾「各自归一化」（几路量级差很多时用）；可填通道（如 `0,1`）
- 参数下发：输入框的个数和标签跟着配置里的 `paramNames` 走
- 运行控制：启动 / 停止 / 重来，正文来自 `cmdStart` / `cmdStop` / `cmdReset`
- 底部显示当前 CSV 路径和通道配置，一眼看出数据到底往哪落
- 波形每秒刷新一次，可以「暂停」定格看细节

面板里没有「模拟数据」按钮 —— 没硬件时要假数据，让模型调 `autopid_open`（`simulate: true`）就行。

## 工具（给模型用）

| 工具 | 作用 |
|---|---|
| `autopid_ports` | 列出本机串口 |
| `autopid_open` | 打开 / 切换串口，`simulate:true` 切假数据 |
| `autopid_status` | 连接状态、收了多少行、缓冲多少点、数据多旧 |
| `autopid_stats` | 每通道 min/max/mean/rms/峰峰 + 振荡频率估计 |
| `autopid_samples` | **读落盘的 CSV**（默认 `csvPath`，可传 `file` 读任意 CSV），支持 `window` / `start,end` / `limit` / `channels`；想自己算超调、上升时间、稳态误差用它 |
| `autopid_plot` | 出图，支持 `window` / `start,end` / `channels` / `normalize`；**只回文件路径，不内联图片** |
| `autopid_set` | 按 `paramNames` / `setFormat` 下发参数（或 `raw` 发原文），**并回报发完之后 `waitMs` 内有没有新数据进来** |
| `autopid_command` | **启动 / 停止 / 重来**（`action: start\|stop\|reset`，或 `raw` 发任意文本），正文来自配置；同样回报有没有新数据 |

下发类工具的回执是刻意分开说的：「新来了 N 行」= 单片机有反应；「一行都没有」= **只是没观察到**，不等于指令没生效，别当成反证。

## 单片机的 printf 要长什么样

最省事的格式，一行一组，逗号分隔，`\r\n` 结尾：

```
printf("%d,%d,%d,%d\r\n", leftEnc, rightEnc, leftPwm, rightPwm);
```

带标签也能吃（数字按出现顺序取）：

```
printf("L:%d,R:%d,PL:%d,PR:%d\r\n", ...);
```

这一行同时是 VOFA+ 的 **FireWater** 协议格式，所以串口接 VOFA+ 也能直接看（但同一个串口同一时刻只能被一个程序打开，见下）。

## 和 VOFA+ 同时用

串口是独占的，插件和 VOFA+ 抢同一个 COM 口会打架。两条路：

1. **插件转发**（推荐）：bridge 读串口，自己画图的同时把原始字节转发到 TCP。VOFA+ 选「网络 → TCP 客户端」连 `127.0.0.1:8766`，协议选 FireWater。
2. **虚拟串口对**：装 com0com，把 COM3 镜像成两个口，一边一个。

## 自动调参要单片机配合

`autopid_set` 只是把配好的那一行发出去，**单片机得自己实现接收解析**才有用。最小实现：

```c
/* 在 main 里开接收 */
static uint8_t rxbyte;
HAL_UART_Receive_IT(&huart3, &rxbyte, 1);

/* 回调里攒行、解析 */
void HAL_UART_RxCpltCallback(UART_HandleTypeDef *huart)
{
  /* 攒到 '\n' 就解析；
     setFormat=positional 时收 "SET 1.20 0.03 0.30"
     setFormat=named     时收 "SET kp=1.20 ki=0.03 kd=0.30" */
  HAL_UART_Receive_IT(&huart3, &rxbyte, 1);
}
```

启动 / 停止 / 重来同理：`cmdStart` 之类填什么，板子就收到什么，自己 `strcmp` 一下就行。

## 目录

```
dsh-autoPID/
├── lib/index.js          # Host 半：工具 + /api/autopid/* 同源路由 + 拉起 bridge
├── client.js             # Client 半：「设置 → 插件 → 自动调参」面板
├── bridge/bridge.py      # 串口读写 + 缓冲 + HTTP + Pillow 画图
├── bridge/requirements.txt
├── test/smoke.mjs        # 工具那半（自己起模拟 bridge）
├── test/web-routes.mjs   # /api/autopid/* 那半（真起 bridge）
├── test/client-half.mjs  # Client 半的装配（不渲染 React）
├── cordis.patch.yml
└── package.json
```

## 自测

```bash
node test/smoke.mjs          # 自己起一个模拟 bridge，验全部工具
node test/web-routes.mjs     # 自己起 bridge，验页面那几条路由
node test/client-half.mjs    # 只验装配，不渲染 React
```

三个都是自包含的：不插板子、不启动 DSH，跑完自己收场。`--simulate` 会造一路方波 + 一路斜坡 + 一路噪声。

想手动看波形：`python bridge/bridge.py --simulate --http 8765`，浏览器开 `http://127.0.0.1:8765/plot?window=5`。

## License

MIT
