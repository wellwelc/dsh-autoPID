# dsh-autoPID

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 用的**串口波形图 + PID 调参**插件。

它把单片机 printf 出来的 CSV 变成一张张波形图，**直接显示在对话里**——不需要另开上位机，也不需要给 DSH 写界面代码。

```
单片机 ──串口──> bridge.py(pyserial) ──HTTP──> 插件工具 ──> 对话里的 PNG
```

## 为什么这么设计

**串口不在 Node 里读**：DSH 跑在 Electron 里，`serialport` 是原生模块，要按 Electron 的 ABI 重新编译，换个 DSH 版本就容易挂。`pyserial` 是纯 Python，`pip install pyserial` 一次就完事。

**波形图不嵌 UI**：给 DSH 写 client 插件要走 React + esbuild 打包，还要对齐 `@deepseek-ai/dsh-client-*` 的版本，改一次重建一次。而调参是个高频试错的活，工具返回 PNG 这种形态改一行就生效。

**选哪段让模型自己判断**：`autopid_stats` 给统计（峰峰值、振荡频率），模型据此决定画哪一段，再 `autopid_plot` 指定 `start/end` 出图。比固定窗口更容易抓到「这段在振」的那一刻。

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
`dsh.profile.bundles`，然后重启 DSH。

3. 在 DSH 设置页里填串口名（如 `COM3`）和波特率，或者直接改 `cordis.patch.yml`。

## 工具

| 工具 | 作用 |
|---|---|
| `autopid_ports` | 列出本机串口 |
| `autopid_status` | 连接状态、收了多少行、缓冲多少点、数据多旧 |
| `autopid_stats` | 每通道 min/max/mean/rms/峰峰 + 振荡频率估计 |
| `autopid_plot` | 出图，支持 `window` / `start,end` / `channels` / `normalize` |
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
├── lib/index.js          # DSH 插件：注册工具、拉起 bridge
├── bridge/bridge.py      # 串口读写 + 缓冲 + HTTP + Pillow 画图
├── bridge/requirements.txt
├── test/smoke.mjs        # 不启动 DSH 的冒烟测试
├── cordis.patch.yml
└── package.json
```

## 自测

```bash
# 一个终端
python bridge/bridge.py --simulate --http 8765

# 另一个终端
node test/smoke.mjs
```

`--simulate` 会造一路方波 + 一路斜坡 + 一路噪声，没有硬件也能验证整条链路。

## License

MIT
