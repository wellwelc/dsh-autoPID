# dsh-autoPID

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 用的**串口波形图 + PID 调参**插件。

波形显示在 DSH 自己的界面里：**设置 → 插件 → 自动调参**。串口由 Python 桥独占，DSH 不碰串口。

```
单片机 ──串口──> bridge.py(pyserial) ──HTTP──> Host 路由 /api/autopid/* ──> 设置页里的实时波形
                                      └──────> 工具（给模型看统计、出图）
```

## 为什么这么设计

**串口不在 Node 里读**：DSH 跑在 Electron 里，`serialport` 是原生模块，要按 Electron 的 ABI 重新编译，换个 DSH 版本就容易挂。`pyserial` 是纯 Python，`pip install pyserial` 一次就完事。

**波形不再以图片塞进工具结果**（2026-11-01 踩过的坑）：工具结果的 `content` 里返回 `{type:'image'}` 会让**该会话之后每一次**请求在 20 毫秒内 `TRANSPORT` 失败，图永远留在历史里 → 会话永久作废（8 KB 小图也会触发）。所以现在：

- `autopid_plot` 只**落盘** PNG 并回文字路径，人自己打开看；
- 想**在界面里实时看**，去看设置页的「自动调参」面板 —— 它用 `<img>` 每秒重取一张，不进模型上下文。

**页面走 Host 同源路由，不直连桥的端口**：桥的端口是配置项、随时可能改；页面只认 `/api/autopid/*`，端口换了页面不用动（`cordis.patch.yml` 里 `httpPort` 改完重启即可）。

**选哪段让模型自己判断**：`autopid_stats` 给统计（峰峰值、振荡频率），模型据此决定画哪一段，再 `autopid_plot` 指定 `start/end` 出图。

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

- 串口：选口、改波特率、打开 / 关闭 / 「模拟数据」（没硬件也能看波形）
- 时间窗：5 / 10 / 20 / 30 / 60 / 120 秒；可勾「各自归一化」（几路量级差很多时用）；可填通道（如 `0,1`）
- 参数下发：kp / ki / kd → 发文本 `SET kp ki kd`
- 波形每秒刷新一次，可以「暂停」定格看细节

## 工具（给模型用）

| 工具 | 作用 |
|---|---|
| `autopid_ports` | 列出本机串口 |
| `autopid_open` | 打开 / 切换串口，`simulate:true` 切假数据 |
| `autopid_status` | 连接状态、收了多少行、缓冲多少点、数据多旧 |
| `autopid_stats` | 每通道 min/max/mean/rms/峰峰 + 振荡频率估计 |
| `autopid_plot` | 出图，支持 `window` / `start,end` / `channels` / `normalize`；**只回文件路径，不内联图片** |
| `autopid_set` | 下发参数，默认发 `SET v1 v2 v3\n` |

## 单片机这边要输出什么

最省事的格式，一行一组，逗号分隔，`\r\n` 结尾：

```
30,28,1500,1500
30,29,1500,1500
```

bridge 只认数字，带标签也能吃：

```
L:30,R:28,PL:1500,PR:1500
```

这一行同时是 VOFA+ 的 **FireWater** 协议格式，所以串口接 VOFA+ 也能直接看（但同一个串口同一时刻只能被一个程序打开，见下）。

## 和 VOFA+ 同时用

串口是独占的，插件和 VOFA+ 抢同一个 COM 口会打架。两条路：

1. **插件转发**（推荐）：bridge 读串口，自己画图的同时把原始字节转发到 TCP。VOFA+ 选「网络 → TCP 客户端」连 `127.0.0.1:8766`，协议选 FireWater。
2. **虚拟串口对**：装 com0com，把 COM3 镜像成两个口，一边一个。

## 自动调参要单片机配合

`autopid_set` 只是把 `SET ...` 发出去，**单片机得自己实现接收解析**才有用。最小实现：

```c
/* 在 main 里开接收 */
static uint8_t rxbyte;
HAL_UART_Receive_IT(&huart3, &rxbyte, 1);

/* 回调里攒行、解析 */
void HAL_UART_RxCpltCallback(UART_HandleTypeDef *huart)
{
  /* 攒到 '\n' 就解析；"SET kp ki kd" -> 更新 PID 系数 */
  HAL_UART_Receive_IT(&huart3, &rxbyte, 1);
}
```

## 目录

```
dsh-autoPID/
├── lib/index.js          # Host 半：工具 + /api/autopid/* 同源路由 + 拉起 bridge
├── client.js             # Client 半：「设置 → 插件 → 自动调参」面板
├── bridge/bridge.py      # 串口读写 + 缓冲 + HTTP + Pillow 画图
├── bridge/requirements.txt
├── test/smoke.mjs        # 工具那半（不启动 DSH）
├── test/web-routes.mjs   # /api/autopid/* 那半（真起 bridge）
├── test/client-half.mjs  # Client 半的装配（不渲染 React）
├── cordis.patch.yml
└── package.json
```

## 自测

```bash
# 一个终端
python bridge/bridge.py --simulate --http 8765

# 另一个终端
node test/smoke.mjs
node test/web-routes.mjs     # 自己起 bridge，不用先开
node test/client-half.mjs    # 只验装配，不渲染
```

`--simulate` 会造一路方波 + 一路斜坡 + 一路噪声，没有硬件也能验证整条链路。

## License

MIT
