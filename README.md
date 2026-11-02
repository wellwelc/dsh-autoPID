# dsh-autoPID

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 用的**串口波形图 + PID 调参**插件。

波形显示在 DSH 自己的界面里：**设置 → 插件 → 自动调参**。串口由 Python 桥独占，DSH 不碰串口。

## 三步装起来

```bash
pip install pyserial pillow                                  # 1. Python 依赖（桥要用）
dsh plugin --profile desktop add github:wellwelc/dsh-autoPID # 2. 装插件
# 3. 重启 DSH，然后 设置 → 插件 → 自动调参 里选串口、填波特率、打开
```

装完就能用：单片机按 `printf("%d,%d,%d\r\n", ...)` 往外发，面板里就有波形；让模型调 `autopid_stats` / `autopid_plot` 看统计和出图；调参时它先读 `rules/tuning-rules.md`，再按你在滑块上给的四项关注度打分推进。

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

## 可编辑的配置（不用碰文件）

在**设置 → 插件 → 自动调参**里有一张「配置」卡片，这些字段直接填、点保存就生效：

| 字段 | 作用 |
|---|---|
| `csvPath` | 数据落盘到这个 `.csv`（绝对路径）；空 = 不落盘 |
| `channels` | 保留前几路数据；0 = 按第一行自动。配 2 就只存前 2 列 |
| `channelNames` | 通道名，逗号分隔（`L,R,PL,PR`），决定 CSV 表头和面板显示 |
| `paramNames` | 下发参数的名字和个数（`kp,ki,kd`），顺序就是数值顺序 |
| `setFormat` | `positional` → `SET 1.2 0.03 0.3`；`named` → `SET kp=1.2 ki=0.03 kd=0.3` |
| `cmdStart` / `cmdStop` / `cmdReset` | 「启动 / 停止 / 重来」三条指令的正文，想发什么文本都行 |

**存在哪**：`$DSH_HOME/autopid/settings.json`（默认 `C:\Users\<你>\.dsh\autopid\settings.json`），面板底部会显示实际路径。

**怎么生效**：保存 → 写盘 → 立刻 `POST /configure` 推给桥，**不用重启 DSH，也不用重启桥**。

**优先级**：`settings.json` > `cordis.patch.yml` 里的默认值。也就是说，只要你在面板里保存过一次，那几项就以文件为准；DSH 设置 → 插件里那个由 schema 生成的表单仍然是同一套字段（改它会写回 cordis 配置），但被 settings.json 里存过的值盖住时不会生效。

**模型也能改**：`autopid_config` 工具，`patch` 传要改的字段；不传就是只读。

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

2. 装进 DSH profile（三选一）：

```bash
# 直接从 GitHub 装（推荐给"别人下下来就能用"）
dsh plugin --profile desktop add github:wellwelc/dsh-autoPID

# 或者装 release 里的 tgz
dsh plugin --profile desktop add https://github.com/wellwelc/dsh-autoPID/releases/download/v0.3.3/dsh-autopid-0.3.3.tgz

# 或者本地开发：link 进去
dsh plugin --profile desktop add link:<本仓库绝对路径>
```

国内网络记得先设代理或换镜像，否则 pnpm 拉包会卡：

```powershell
$env:HTTP_PROXY="http://127.0.0.1:7897"; $env:HTTPS_PROXY="http://127.0.0.1:7897"
```

也可以直接改 `~/.dsh/profiles/desktop/package.json` 的 `dependencies` 加一行
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

## 怎么用：从接上板子到调出一组参数

下面这一套是我们真车调参时走顺的流程，照着做最省事。

### 1. 硬件先通

- 板上 `printf` 一行纯数字，`\r\n` 结尾（格式见下一节）
- USB-TTL 的 **RX 接板子的 TX**，**共地**
- 板的**逻辑供电**由 USB 给，**执行器（电机/舵机）要另接电源** —— 只插 USB 时数据是通的、轮子不转，这个很容易误判成"参数调坏了"

### 2. 在面板里打开串口

设置 → 插件 → 自动调参 → 选串口、填波特率（大多数单片机是 115200）→ 打开。

打开之后**立刻看有没有数据**：累计行数应该在涨。一行都不涨时先别调参数，看 Q&A 第 2 条。

### 3. 下发参数

面板里的输入框个数和标签，跟着配置里的 `paramNames` 走。比如 `kp,ki,kd` 就填三个数字，`kp,ki,kd,p1,p2,d,g` 就填七个数，顺序即数值顺序。

**⚠️ 关键：下发的数字通常不等于实际生效值。** 固件里一般还有一套缩放常数，例如：

```c
#define PIDInc_Kp 1.0
#define PIDInc_Ki 0.03
#define PIDInc_Kd 0.3
```

你发 `SET 20 30 0`，板子实际吃进去的是 Kp=20、**Ki=0.9**、Kd=0。**报参数时两个数都要给**（下发值 + 实际生效值），否则下次谁也复现不出来。

### 4. 跑起来看数据

- 点「启动」发 `cmdStart`（默认 `START`）
- 面板波形每秒刷一次，可以暂停定格
- 要更细的图，让模型出：`autopid_plot` 支持 `width: 3200`、`height: 520`，横轴拉长才看得出细节

### 5. 一轮只改一档

**顺序固定：先 STOP，再改参数，然后 RESET，最后 START。**

改完立刻 `RESET` 是必须的 —— 不然累加式的积分量会带着上一轮的状态继续跑，数据没法比。

**单步不超过 2 倍。** 软件的"翻十倍"只是跑得慢，硬件的"翻十倍"可能把管子烧了。

### 6. 每轮都留证据

至少记四个数：稳态误差、上升时间、抖动、超调/摆动。加上「采集窗口的时间戳」，下一轮才有得比。

---

## Q&A

### 1. 面板说「没找到串口」

三种完全不同的情况长得一模一样：**还没查完**（刚起来）、**查询失败**（Python 环境没装好）、**真的没有设备**。

先做这两步：
1. 点一下「刷新」，等两秒（首次查询偶尔会撞空）
2. 命令行跑 `python -c "import serial.tools.list_ports as p; print([x.device for x in p.comports()])"`

列出来是空的 → 线/驱动问题；报 `ModuleNotFoundError` → `pip install pyserial`。

### 2. 串口打开了，但一行数据都没有

按这个顺序查，别跳：

| 检查 | 判据 |
|---|---|
| 板子有没有在发 | 串口助手/`autopid_status` 的累计行数动不动 |
| 是不是刚烧录或断电重新上电 | **把串口关掉再重新打开** —— 烧录会让串口句柄失效，这一步救回来过很多次 |
| 板的打印条件 | 很多固件有 `if (tick % N == 0)` 之类的分频，`tick` 还是 0 时**一条都不打**（发个 START 让 tick 跑起来） |
| 线 | TX/RX 有没有接反、有没有共地 |
| 程序卡在初始化 | 打断点看是不是停在某个 `while(...)` 里（比如等电调/等传感器） |

### 3. 数据在流，但数值全是 0

先分清两件事：

- **目标就是 0**（没发 START，或者目标序列已经跑完归零）→ 正常
- **目标不为 0、速度还是 0** → 执行器没通电／没使能／编码器没接

**判据**：看有没有"命令回执"。比如单片机对每条命令回一个 `OK`，PC 侧会把它记成一行坏行（`bad_lines`）。**发了命令 `bad_lines` 不涨 = 命令根本没到板子**，这时候就别改参数了。

### 4. 发了参数，可是效果完全没变

两个最常见的原因：

1. **命令没到**（见上一条，用坏行计数做阳性对照）
2. **参数被别处覆盖了**：比如固件里把四个参数写成"调用处的常量"，那你改结构体字段没用 —— 得让调用处读变量

还有一种隐蔽的：增量式 PID 在 **Ki = 0** 时输出恒为 0（`Kp` 那一项在匀速段等于零），所以参数没送到、`Ki` 还是默认 0 时，**轮子一点不动**，看起来特别像硬件坏了。

### 5. 出图只画出一小段 / 只看到一轮

`window` 是**按"现在"往回数**，不是按"数据末尾"往回数。数据已经停了（`autopid_status` 里 `newest_age` 很大）时用 `window` 只会画到时间窗里那一丁点。

改用 `start` / `end` 指定这一轮的起止时间戳。

### 6. 改完规则文件，为什么不生效

分两种：

- **调参卡 / 规则文件的正文** → 每轮现读，改完下一轮就生效，**不用重启**
- **工具、路由、配置 schema、面板组件** → 启动时装配，**必须重启 DSH**

判断依据很简单：改的是 `.md` 就是第一种；改的是 `lib/index.js` / `client.js` 就是第二种。

### 7. 波形突然断了，重开又好了

USB 被拔插、板子重新上电、切换串口之后，桥那边的句柄会失效。**关掉串口再重新打开**就行，这是最常见的"假故障"。

### 8. 能不能和 VOFA+ 同时看

同一个串口同一时刻只能被一个程序打开。要么用插件的 TCP 转发，要么装 com0com 做虚拟串口对，见下面一节。

### 9. 图看不清细节

`autopid_plot` 传 `width: 3200`、`height: 520`（甚至 `14400 × 2400`）。默认 1280 宽，锯齿会把高频抖动糊掉。

### 10. 为什么工具不回图片，只给路径

因为**工具结果里返回图片会让会话永久报废**：那张图会留在会话历史里，之后每次请求都在 20 毫秒内失败（`TRANSPORT`），重试、换模型都没用。所以插件只落盘 + 回路径，人自己打开看，或者在对话框里用 Markdown 图片语法贴。



## 工具（给模型用）

| 工具 | 作用 |
|---|---|
| `autopid_ports` | 列出本机串口 |
| `autopid_open` | 打开 / 切换串口，`simulate:true` 切假数据 |
| `autopid_status` | 连接状态、收了多少行、缓冲多少点、数据多旧 |
| `autopid_stats` | 每通道 min/max/mean/rms/峰峰 + 振荡频率估计 |
| `autopid_samples` | **读落盘的 CSV**（默认 `csvPath`，可传 `file` 读任意 CSV），支持 `window` / `start,end` / `limit` / `channels`；想自己算超调、上升时间、稳态误差用它 |
| `autopid_plot` | 出图，支持 `window` / `start,end` / `channels` / `normalize` / **`width` / `height`**（想看细节给 3200）；**只回文件路径，不内联图片** |
| `autopid_set` | 按 `paramNames` / `setFormat` 下发参数（或 `raw` 发原文），**并回报发完之后 `waitMs` 内有没有新数据进来** |
| `autopid_command` | **启动 / 停止 / 重来**（`action: start\|stop\|reset`，或 `raw` 发任意文本），正文来自配置；同样回报有没有新数据 |
| `autopid_config` | 读 / 改配置（跟面板那张「配置」卡片是同一份数据，改完立即生效并写盘） |
| `autopid_tuning_rules` | 读**插件内置的调参规则**（`rules/tuning-rules.md`）+ 当前四个关注度权重；传 `metrics` 还会按权重打分（`steadyErr` / `riseMs` / `ripple` / `swing`） |

下发类工具的回执是刻意分开说的：「新来了 N 行」= 单片机有反应；「一行都没有」= **只是没观察到**，不等于指令没生效，别当成反证。

## 调参规则与关注度（这份是给模型看的）

调参这件事最怕模型凭直觉加大增益。所以规则不写在提示词里，**写进插件自己的文件**：

`rules/tuning-rules.md` —— 机理（增量式 PID 为什么稳态靠 Ki）、流程（先 Ki 再 Kp 最后 Kd）、每轮必记的四项指标、以及几条硬性红线（单步放大不超过 2 倍、先 STOP 再改、能空转就空转、异常先退回安全值）。

**四个权重由人来定**，在设置页里是四条滑块（0~100），存进 `~/.dsh/autopid/settings.json`：

| 字段 | 关注什么 | 默认 |
|---|---|---|
| `tuneKpOsc` | Kp 引起的高频抖动 | 40 |
| `tuneKiOsc` | Ki 引起的低频摆动 / 超调 | 50 |
| `tuneSpeed` | 响应速度（上升时间） | 50 |
| `tuneSteady` | 稳态均值 / 稳态误差 | 60 |

模型每次调参前调 `autopid_tuning_rules`，拿到规则全文 + 当前权重，按规则推进、按权重打分：

```
score = 100
      - tuneSteady × steadyErr%  / 100
      - tuneSpeed  × riseMs      / 100
      - tuneKpOsc  × rippleRatio / 100
      - tuneKiOsc  × swingRatio  / 100
```

权重调高 → 模型更在意那一项；想让它别把车调抖，就把 `tuneKpOsc` 拉大。**规则里写死的红线不受权重影响**，权重只决定取舍方向。

改完 `rules/tuning-rules.md` 不用重启，下次调 `autopid_tuning_rules` 就是新版。

### 调参卡（你自己写的那个文件）

`rules/tuning-rules.md` 是**读一遍就够**的长手册；**调参卡**是**每轮都挂在系统提示里**的那段话，内容由**人**决定：

- 卡本体 = `rules/tuning-card.md`，**直接改这个文件就行**，改完对下一轮生效（插件每轮现读，不缓存、不用重启）
- 想放到自己习惯的位置：设置里 `tuningCardPath` 填绝对路径（留空 = 用插件自带那份）
- 不想让它常驻：`tuningCard` 关掉，那样只有模型主动调 `autopid_tuning_rules` 才看得到规则
- 卡里写 `{{kpOsc}}` `{{kiOsc}}` `{{speed}}` `{{steady}}` 会被替换成滑块上的当前值；不写就原样注入
- 文件读不到时退回一段内置兜底文案，不会让插件报错

**在面板里直接改**：设置页「自动调参」里有一块「调参卡」折叠区 —— 一个大输入框显示当前卡内容，改完点「保存卡」就写回文件（对下一轮生效），旁边还能「重新读」；下面会展开「模型实际看到的内容」（占位符已替换的那份），方便确认写对了。想换位置就在同一块的配置里填 `tuningCardPath`。

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
├── rules/tuning-rules.md # 调参规则（给模型看的操作手册，可自己改）
├── bridge/bridge.py      # 串口读写 + 缓冲 + HTTP + Pillow 画图
├── bridge/requirements.txt
├── test/smoke.mjs        # 工具那半（自己起模拟 bridge）
├── test/web-routes.mjs   # /api/autopid/* 那半（真起 bridge）
├── test/client-half.mjs  # Client 半的装配（不渲染 React）
├── test/tuning-rules.mjs # 调参规则工具（读文件、打分、权重生效）
├── cordis.patch.yml
└── package.json
```

## 自测

```bash
node test/smoke.mjs          # 自己起一个模拟 bridge，验全部工具
node test/web-routes.mjs     # 自己起 bridge，验页面那几条路由
node test/client-half.mjs    # 只验装配，不渲染 React
node test/tuning-rules.mjs   # 调参规则工具：读文件、打分、权重改动生效（纯逻辑，不用串口）
```

三个都是自包含的：不插板子、不启动 DSH，跑完自己收场。`--simulate` 会造一路方波 + 一路斜坡 + 一路噪声。

想手动看波形：`python bridge/bridge.py --simulate --http 8765`，浏览器开 `http://127.0.0.1:8765/plot?window=5`。

## License

MIT
