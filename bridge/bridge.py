#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
dsh-autoPID 串口桥

职责很窄：
  1. 开一个串口，按行读，把每行解析成一组数字
  2. 存进环形缓冲（带时间戳），不落盘
  3. 用 HTTP 暴露出去：状态 / 统计 / 画图 / 下发参数

刻意不做的事情：
  - 不做调参算法（那属于上层，由 AI 决定取哪段、怎么算）
  - 不存历史数据（电池和磁盘都省着）
  - 不自己抢串口显示（VOFA+ 要看得走 /raw 转发或者虚拟串口对）

用法：
  python bridge.py --port COM3 --baud 115200 --http 8765
  python bridge.py --simulate            # 无硬件时造正弦+噪声，自测用
"""

import argparse
import base64
import io
import json
import math
import os
import sys
import threading
import time
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

from PIL import Image, ImageDraw, ImageFont

try:
    import serial
    from serial.tools import list_ports
except ImportError:
    serial = None

# ---------------------------------------------------------------- 全局状态

LOCK = threading.Lock()
BUFFER = deque(maxlen=200_000)          # (t_seconds, [float, ...])
CHANNEL_COUNT = 0                        # 以第一条有效数据为准
SERIAL_OBJ = None
SERIAL_LOCK = threading.Lock()
STATUS = {
    "connected": False,
    "port": None,
    "baud": None,
    "lines": 0,
    "bad_lines": 0,
    "last_line": "",
    "last_error": None,
    "started_at": time.time(),
}
RAW_SUBSCRIBERS = []                     # 给 /raw 转发用（VOFA+ 可以挂 TCP）
STOP = threading.Event()
# 当前采集线程的"停"信号（换串口时只停这一根，不惊动整个进程）
WORKER = {"event": None, "thread": None, "mode": None}

# ---------------------------------------------------------------- 可编辑的采集配置
#
# 这几项由 Host 通过 POST /configure 在运行时下发（改了不用重启桥）：
#   csv_path       收到的数据往哪个 .csv 里追加；空字符串 = 不落盘
#   channels       保留前几路；0 = 按第一行自动
#   channel_names  各通道叫什么（空 = CH0、CH1……），只影响 CSV 表头和回执
#   param_names    下发参数的名字，顺序就是 values 的顺序（如 kp / ki / kd）
#   set_format     positional -> "SET 1.2 0.03 0.3"
#                  named      -> "SET kp=1.2 ki=0.03 kd=0.3"
#   cmd_start/stop/reset  启动 / 停止 / 重来 三条指令的正文（各占一行，自动补 \n）
CFG = {
    "csv_path": "",
    "channels": 0,
    "channel_names": [],
    "param_names": ["kp", "ki", "kd"],
    "set_format": "positional",
    "cmd_start": "START",
    "cmd_stop": "STOP",
    "cmd_reset": "RESET",
}
CSV_LOCK = threading.Lock()
CSV_STATE = {"path": "", "rows": 0, "last_error": ""}
MAX_CSV_SCAN = 2_000_000                  # 读 CSV 时最多扫这么多行，防止误开一个巨型文件


PALETTE = [
    "#2E86DE", "#EE5A24", "#10AC84", "#8C7AE6",
    "#F79F1F", "#00CEC9", "#E84393", "#6D4C41",
]


# ---------------------------------------------------------------- 字体

_FONT_CACHE = {}


def font(size):
    if size in _FONT_CACHE:
        return _FONT_CACHE[size]
    for path in (
        r"C:\Windows\Fonts\msyh.ttc",
        r"C:\Windows\Fonts\msyhbd.ttc",
        r"C:\Windows\Fonts\simhei.ttf",
        r"C:\Windows\Fonts\simsun.ttc",
    ):
        if os.path.exists(path):
            try:
                f = ImageFont.truetype(path, size)
                _FONT_CACHE[size] = f
                return f
            except Exception:
                pass
    f = ImageFont.load_default()
    _FONT_CACHE[size] = f
    return f


# ---------------------------------------------------------------- 解析

def parse_line(raw: bytes):
    """把一行字节解析成 float 列表；解析不出东西就返回 None。

    兼容几种常见写法：
        "1,2,3"
        "1 2 3"
        "L:1,R:2"
        "1,2,3;4,5"
    只认数字，别的一律丢掉，所以带标签的 CSV 也能用。
    """
    try:
        text = raw.decode("utf-8", errors="ignore")
    except Exception:
        return None
    text = text.strip()
    if not text:
        return None

    out = []
    token = ""
    for ch in text:
        if ch.isdigit() or ch in "+-.eE":
            token += ch
        else:
            if token:
                out.append(token)
                token = ""
    if token:
        out.append(token)

    vals = []
    for t in out:
        if t in ("+", "-", ".", "e", "E"):
            continue
        try:
            vals.append(float(t))
        except ValueError:
            continue
    return vals or None


# ---------------------------------------------------------------- CSV 落盘 / 读回

def channel_names_for(n):
    """给 n 个通道配名字：配置里给了就用配置的，不够的补 CH<i>。"""
    names = CFG.get("channel_names") or []
    return [names[i] if i < len(names) else f"CH{i}" for i in range(n)]


def trim_channels(vals):
    """按配置的通道数截断。配的是 3 路就只留前 3 个 —— 不够就照原样返回，不补 0
    （补 0 等于替板子编数据）。"""
    n = CFG.get("channels") or 0
    if n > 0 and len(vals) > n:
        return list(vals[:n])
    return list(vals)


def append_csv(t, vals):
    """把一行原始数据追加进 CSV。表头只在文件是新建/空的时候写一次。"""
    path = CFG.get("csv_path") or ""
    if not path:
        return
    with CSV_LOCK:
        try:
            folder = os.path.dirname(os.path.abspath(path))
            if folder:
                os.makedirs(folder, exist_ok=True)
            need_header = (not os.path.exists(path)) or os.path.getsize(path) == 0
            with open(path, "a", encoding="utf-8", newline="") as f:
                if need_header:
                    f.write("t," + ",".join(channel_names_for(len(vals))) + "\n")
                f.write(f"{t:.6f}," + ",".join(f"{v:.6f}" for v in vals) + "\n")
            CSV_STATE["path"] = path
            CSV_STATE["rows"] += 1
            CSV_STATE["last_error"] = ""
        except Exception as e:      # 写不进去要说出来，别装作存了
            CSV_STATE["last_error"] = str(e)


def read_csv_file(path, start=None, end=None, limit=200, picks=None):
    """读一份 CSV，返回 (header, rows)。

    rows 是 [[t, v1, v2, ...], ...]，t 用第一列。
    兼容两种文件：
      · 有表头（第一行不是数字）：表头当通道名
      · 没有表头（第一行就是数字）：通道名用 CH0、CH1……
    时间范围过滤用 t；limit 之外的点按等间隔抽稀。
    """
    header = []
    data = []
    scanned = 0
    with open(path, "r", encoding="utf-8", errors="ignore", newline="") as f:
        for raw in f:
            scanned += 1
            if scanned > MAX_CSV_SCAN:
                break
            line = raw.strip().lstrip("\ufeff").strip()
            if not line:
                continue
            cells = [c.strip() for c in line.replace(";", ",").split(",")]
            if not header and not data:
                # 第一条：像不像数字？不像就当表头
                try:
                    float(cells[0])
                except ValueError:
                    header = [c or f"CH{i}" for i, c in enumerate(cells)]
                    continue
            try:
                t = float(cells[0])
            except ValueError:
                continue
            vals = []
            for c in cells[1:]:
                try:
                    vals.append(float(c))
                except ValueError:
                    vals.append(float("nan"))
            if start is not None and t < start:
                continue
            if end is not None and t > end:
                continue
            data.append([t] + vals)

    total = len(data)
    if limit and total > limit:
        step = max(1, total // limit)
        data = data[::step]

    if picks:
        picked = []
        for row in data:
            keep = [row[i + 1] if 0 <= i < len(row) - 1 else None for i in picks]
            picked.append([row[0]] + keep)
        data = picked
    return header, data


def apply_config(body):
    """更新 CFG。返回值给回执里用，让调用方知道到底改成了什么。"""
    if not isinstance(body, dict):
        return dict(CFG)
    if "csv_path" in body:
        CFG["csv_path"] = str(body.get("csv_path") or "")
        CSV_STATE["path"] = CFG["csv_path"]
        CSV_STATE["rows"] = 0
    if "channels" in body:
        try:
            CFG["channels"] = max(0, int(body.get("channels") or 0))
        except (TypeError, ValueError):
            pass
    if "channel_names" in body:
        raw = body.get("channel_names")
        if isinstance(raw, str):
            raw = [x.strip() for x in raw.replace("，", ",").split(",")]
        CFG["channel_names"] = [str(x).strip() for x in (raw or []) if str(x).strip()]
    if "param_names" in body:
        raw = body.get("param_names")
        if isinstance(raw, str):
            raw = [x.strip() for x in raw.replace("，", ",").split(",")]
        names = [str(x).strip() for x in (raw or []) if str(x).strip()]
        CFG["param_names"] = names or []
    if "set_format" in body:
        fmt = str(body.get("set_format") or "positional").lower()
        CFG["set_format"] = "named" if fmt == "named" else "positional"
    for key in ("cmd_start", "cmd_stop", "cmd_reset"):
        if key in body:
            text = str(body.get(key) or "").strip()
            if text:
                CFG[key] = text
    return dict(CFG)


def build_set_line(vals):
    """按配置拼出要发给单片机的那一行。"""
    names = CFG.get("param_names") or []
    if CFG.get("set_format") == "named" and names and len(names) == len(vals):
        return "SET " + " ".join(f"{n}={v}" for n, v in zip(names, vals)) + "\n"
    return "SET " + " ".join(str(v) for v in vals) + "\n"


def config_snapshot():
    """把当前配置 + CSV 落盘情况一起交出去（界面和模型都看这个）。"""
    return {
        "csv_path": CFG.get("csv_path") or "",
        "csv_written": CSV_STATE["rows"],
        "csv_error": CSV_STATE["last_error"],
        "channels": CFG.get("channels") or 0,
        "channel_names": list(CFG.get("channel_names") or []),
        "param_names": list(CFG.get("param_names") or []),
        "set_format": CFG.get("set_format"),
        "cmd_start": CFG.get("cmd_start"),
        "cmd_stop": CFG.get("cmd_stop"),
        "cmd_reset": CFG.get("cmd_reset"),
        "set_line_example": build_set_line([1.2, 0.03, 0.3]) if (CFG.get("param_names")) else "SET 1.2 0.03 0.3",
    }


# ---------------------------------------------------------------- 串口线程

def serial_worker(port, baud, stop_event=None):
    global SERIAL_OBJ, CHANNEL_COUNT
    stop_event = stop_event or STOP
    while not stop_event.is_set():
        try:
            ser = serial.Serial(port, baud, timeout=0.2)
            with SERIAL_LOCK:
                SERIAL_OBJ = ser
            with LOCK:
                STATUS["connected"] = True
                STATUS["port"] = port
                STATUS["baud"] = baud
                STATUS["last_error"] = None
            while not stop_event.is_set():
                try:
                    raw = ser.readline()
                except Exception as e:
                    with LOCK:
                        STATUS["last_error"] = f"read: {e}"
                    break
                if not raw:
                    continue
                vals = parse_line(raw)
                if vals is None:
                    with LOCK:
                        STATUS["bad_lines"] += 1
                    continue
                vals = trim_channels(vals)
                now = time.time()
                with LOCK:
                    if CHANNEL_COUNT == 0:
                        CHANNEL_COUNT = CFG.get("channels") or len(vals)
                    STATUS["lines"] += 1
                    STATUS["last_line"] = raw.decode("utf-8", errors="ignore").strip()[:200]
                    BUFFER.append((now, vals))
                append_csv(now, vals)
                for sub in list(RAW_SUBSCRIBERS):
                    try:
                        sub(raw)
                    except Exception:
                        pass
        except Exception as e:
            with LOCK:
                STATUS["connected"] = False
                STATUS["last_error"] = str(e)
            stop_event.wait(2.0)
        finally:
            with SERIAL_LOCK:
                if SERIAL_OBJ is not None:
                    try:
                        SERIAL_OBJ.close()
                    except Exception:
                        pass
                    SERIAL_OBJ = None


def simulate_worker(stop_event=None):
    """没有硬件时的假数据：一路方波(模拟 P 振荡) + 一路斜坡 + 一路噪声。"""
    global CHANNEL_COUNT
    stop_event = stop_event or STOP
    CHANNEL_COUNT = 3
    t0 = time.time()
    with LOCK:
        STATUS["connected"] = True
        STATUS["port"] = "SIMULATE"
        STATUS["baud"] = 0
    while not stop_event.is_set():
        t = time.time() - t0
        a = 1200 * math.sin(2 * math.pi * 2.0 * t) + 900 * math.sin(2 * math.pi * 11.0 * t)
        b = 900 + 200 * math.sin(2 * math.pi * 0.3 * t)
        c = 40 * math.sin(2 * math.pi * 37.0 * t)
        vals = [round(a, 2), round(b, 2), round(c, 2)]
        vals = trim_channels(vals)
        now = time.time()
        with LOCK:
            BUFFER.append((now, vals))
            STATUS["lines"] += 1
            STATUS["last_line"] = ",".join(str(v) for v in vals)
        append_csv(now, vals)
        stop_event.wait(0.01)


# ---------------------------------------------------------------- 换串口

def stop_worker():
    """停掉当前采集线程，把串口让出来（换口 / 关掉时用）。"""
    ev = WORKER.get("event")
    if ev is not None:
        ev.set()
    with SERIAL_LOCK:
        ser = SERIAL_OBJ
    if ser is not None:
        try:
            ser.close()
        except Exception:
            pass
    th = WORKER.get("thread")
    if th is not None and th.is_alive():
        th.join(timeout=1.5)
    WORKER["event"] = None
    WORKER["thread"] = None
    WORKER["mode"] = None


def start_worker(mode, port=None, baud=115200):
    """起一根新的采集线程。mode: 'serial' / 'simulate'。"""
    global CHANNEL_COUNT
    stop_worker()
    ev = threading.Event()
    if mode == "simulate":
        CHANNEL_COUNT = 0
        with LOCK:
            STATUS["connected"] = False
            STATUS["port"] = None
            STATUS["baud"] = None
        th = threading.Thread(target=simulate_worker, args=(ev,), daemon=True)
    else:
        with LOCK:
            STATUS["connected"] = False
            STATUS["port"] = port
            STATUS["baud"] = baud
            STATUS["last_error"] = None
        th = threading.Thread(target=serial_worker, args=(port, baud, ev), daemon=True)
    WORKER["event"] = ev
    WORKER["thread"] = th
    WORKER["mode"] = mode
    th.start()
    return mode


def worker_state():
    th = WORKER.get("thread")
    return {
        "mode": WORKER.get("mode"),
        "alive": bool(th is not None and th.is_alive()),
    }


# ---------------------------------------------------------------- 统计

def snapshot(start=None, end=None):
    with LOCK:
        rows = list(BUFFER)
    if not rows:
        return []
    if start is None:
        start = rows[0][0]
    if end is None:
        end = rows[-1][0]
    return [(t, v) for (t, v) in rows if start <= t <= end]


def stats_of(rows):
    if not rows:
        return {"points": 0, "channels": 0, "duration": 0.0}
    nch = max(len(v) for (_, v) in rows)
    out = {
        "points": len(rows),
        "channels": nch,
        "duration": round(rows[-1][0] - rows[0][0], 3),
        "t0": round(rows[0][0], 3),
        "t1": round(rows[-1][0], 3),
        "per_channel": [],
    }
    for ch in range(nch):
        vals = [v[ch] for (_, v) in rows if len(v) > ch]
        if not vals:
            out["per_channel"].append(None)
            continue
        mn, mx = min(vals), max(vals)
        mean = sum(vals) / len(vals)
        rms = math.sqrt(sum(x * x for x in vals) / len(vals))
        # 过均值次数：粗略反映振荡频率（每两次穿越 = 一个周期）
        crossings = 0
        prev = None
        for x in vals:
            s = x >= mean
            if prev is not None and s != prev:
                crossings += 1
            prev = s
        dur = rows[-1][0] - rows[0][0]
        freq = (crossings / 2.0 / dur) if dur > 0 else 0.0
        out["per_channel"].append({
            "min": round(mn, 3),
            "max": round(mx, 3),
            "mean": round(mean, 3),
            "rms": round(rms, 3),
            "pp": round(mx - mn, 3),
            "freq_hz": round(freq, 2),
        })
    return out


# ---------------------------------------------------------------- 绘图

def render_png(rows, channels=None, width=1400, height=700, title=None,
               normalize=False):
    """把 rows 画成折线图，返回 PNG 字节。"""
    if not rows:
        img = Image.new("RGB", (width, height), "#ffffff")
        d = ImageDraw.Draw(img)
        d.text((40, height // 2 - 10), "no data", fill="#999999", font=font(22))
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        return buf.getvalue()

    nch = max(len(v) for (_, v) in rows)
    if channels is None:
        channels = list(range(nch))
    channels = [c for c in channels if 0 <= c < nch] or list(range(nch))

    pad_l, pad_r, pad_t, pad_b = 78, 24, 54, 52
    plot_w = width - pad_l - pad_r
    plot_h = height - pad_t - pad_b

    img = Image.new("RGB", (width, height), "#ffffff")
    d = ImageDraw.Draw(img)

    t0 = rows[0][0]
    t1 = rows[-1][0]
    span = max(t1 - t0, 1e-6)

    series = {}
    ymin, ymax = float("inf"), float("-inf")
    for ch in channels:
        pts = [(t, v[ch]) for (t, v) in rows if len(v) > ch]
        if not pts:
            continue
        series[ch] = pts
        for _, y in pts:
            ymin = min(ymin, y)
            ymax = max(ymax, y)
    if not series:
        ymin, ymax = 0.0, 1.0
    if normalize:
        ymin, ymax = float("inf"), float("-inf")
        series = {ch: [(t, y) for (t, y) in pts] for ch, pts in series.items()}
        # 归一化：每通道各自缩放到 0..1
        norm = {}
        for ch, pts in series.items():
            lo = min(y for _, y in pts)
            hi = max(y for _, y in pts)
            rng = (hi - lo) or 1.0
            norm[ch] = [(t, (y - lo) / rng) for (t, y) in pts]
        series = norm
        ymin, ymax = 0.0, 1.0
    if ymax - ymin < 1e-9:
        ymax = ymin + 1.0
    margin = (ymax - ymin) * 0.08
    ymin -= margin
    ymax += margin

    def px(t):
        return pad_l + (t - t0) / span * plot_w

    def py(y):
        return pad_t + plot_h - (y - ymin) / (ymax - ymin) * plot_h

    # 网格
    for i in range(11):
        y = pad_t + plot_h * i / 10
        d.line([(pad_l, y), (pad_l + plot_w, y)], fill="#eef0f3")
        val = ymax - (ymax - ymin) * i / 10
        d.text((10, y - 9), f"{val:.4g}", fill="#8a94a6", font=font(15))
    for i in range(11):
        x = pad_l + plot_w * i / 10
        d.line([(x, pad_t), (x, pad_t + plot_h)], fill="#f6f7f9")
        d.text((x - 22, pad_t + plot_h + 8), f"{span * i / 10:.3g}s", fill="#8a94a6", font=font(15))

    d.rectangle([pad_l, pad_t, pad_l + plot_w, pad_t + plot_h], outline="#c8cfda")

    # 曲线
    for idx, ch in enumerate(channels):
        pts = series.get(ch)
        if not pts:
            continue
        color = PALETTE[idx % len(PALETTE)]
        if len(pts) > plot_w * 2:
            step = max(1, len(pts) // (plot_w * 2))
            pts = pts[::step]
        xy = [(px(t), py(y)) for (t, y) in pts]
        d.line(xy, fill=color, width=2, joint="curve")

    # 图例：右对齐，避开左边的标题
    shown = [ch for ch in channels if ch in series]
    lx = pad_l + plot_w - 92 * len(shown) + 10
    for idx, ch in enumerate(shown):
        color = PALETTE[channels.index(ch) % len(PALETTE)]
        d.rectangle([lx, pad_t - 32, lx + 16, pad_t - 18], fill=color)
        d.text((lx + 22, pad_t - 35), f"CH{ch}", fill="#3d4657", font=font(16))
        lx += 92

    head = title or f"{len(rows)} 点  {span:.3f}s"
    d.text((pad_l, 14), head, fill="#1f2733", font=font(20))

    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


# ---------------------------------------------------------------- HTTP

class Handler(BaseHTTPRequestHandler):
    server_version = "dsh-autoPID/0.1"

    def log_message(self, fmt, *args):
        pass

    # ---- helpers ----
    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def _png(self, data):
        self.send_response(200)
        self.send_header("Content-Type", "image/png")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0:
            return {}
        try:
            return json.loads(self.rfile.read(n).decode("utf-8"))
        except Exception:
            return {}

    def _q(self):
        return parse_qs(urlparse(self.path).query)

    # ---- routes ----
    def do_GET(self):
        path = urlparse(self.path).path
        q = self._q()

        if path == "/status":
            with LOCK:
                st = dict(STATUS)
                st["buffer"] = len(BUFFER)
                st["channels"] = CHANNEL_COUNT
                # 未开串口时 port/baud/last_error 是 None；上层工具把它们声明成了
                # string / number，返回 null 会被 DSH 的输出校验打回来（2026-11-01 踩过）。
                st["port"] = st.get("port") or ""
                st["baud"] = st.get("baud") or 0
                st["last_error"] = st.get("last_error") or ""
                if BUFFER:
                    st["oldest_age"] = round(time.time() - BUFFER[0][0], 2)
                    st["newest_age"] = round(time.time() - BUFFER[-1][0], 2)
                if CHANNEL_COUNT:
                    st["channel_names"] = channel_names_for(CHANNEL_COUNT)
            st.update(worker_state())
            st["config"] = config_snapshot()
            self._json(st)
            return

        if path == "/config":
            self._json(config_snapshot())
            return

        if path == "/csv":
            # 读一份存下来的 CSV（默认就是配置里的那个落盘文件）
            file_path = (q.get("path", [""])[0] or CFG.get("csv_path") or "").strip()
            if not file_path:
                self._json({"ok": False, "error": "没有指定 CSV 文件，也没有配置 csv_path"})
                return
            if not os.path.exists(file_path):
                self._json({"ok": False, "error": f"文件不存在：{file_path}", "path": file_path})
                return
            try:
                limit = int(q.get("limit", ["200"])[0])
            except ValueError:
                limit = 200
            limit = max(1, min(5000, limit))
            start = q.get("start", [None])[0]
            end = q.get("end", [None])[0]
            picks = None
            ch = q.get("ch", [None])[0]
            if ch:
                picks = [int(x) for x in ch.split(",") if x.strip().isdigit()]
            try:
                header, rows = read_csv_file(
                    file_path,
                    float(start) if start else None,
                    float(end) if end else None,
                    limit,
                    picks,
                )
            except Exception as e:
                self._json({"ok": False, "error": f"读 CSV 失败：{e}", "path": file_path})
                return
            self._json({
                "ok": True,
                "path": file_path,
                "header": header,
                "rows": rows,
                "total": len(rows),
                "returned": len(rows),
                "t0": rows[0][0] if rows else None,
                "t1": rows[-1][0] if rows else None,
            })
            return

        if path == "/ports":
            # 三种情况必须区分开，不能都回一个空数组：
            #   ① pyserial 没装（列不出来）② 枚举抛异常 ③ 真的一个串口都没有
            # 混在一起的话，界面上只能显示"没找到串口"，人根本不知道是哪种。
            if serial is None:
                self._json({
                    "ports": [],
                    "error": "pyserial 没装成功（import serial 失败），这一侧列不出串口；先 pip install pyserial",
                })
                return
            try:
                ports = [{"device": p.device, "desc": p.description}
                         for p in list_ports.comports()]
            except Exception as e:
                self._json({"ports": [], "error": f"枚举串口失败：{e}"})
                return
            self._json({"ports": ports, "error": ""})
            return

        if path == "/stats":
            win = float(q.get("window", ["0"])[0])
            if win > 0:
                end = time.time()
                rows = snapshot(end - win, end)
            else:
                rows = snapshot()
            self._json(stats_of(rows))
            return

        if path == "/samples":
            # 给 AI 做判断用的抽样文本：不是全量，只给有代表性的点
            try:
                limit = int(q.get("limit", ["200"])[0])
            except ValueError:
                limit = 200
            limit = max(1, min(5000, limit))
            start = q.get("start", [None])[0]
            end = q.get("end", [None])[0]
            s = float(start) if start else None
            e = float(end) if end else None
            rows = snapshot(s, e)
            total = len(rows)
            if total > limit:
                step = max(1, total // limit)
                rows = rows[::step]
            # 选通道：和 /plot 一样，只回被点名的那几路
            picks = None
            ch = q.get("ch", [None])[0]
            if ch:
                picks = [int(x) for x in ch.split(",") if x.strip().isdigit()]
            out_rows = []
            for t, vals in rows:
                if picks is None:
                    keep = vals
                else:
                    keep = [vals[i] if 0 <= i < len(vals) else None for i in picks]
                out_rows.append([round(t, 4)] + keep)
            self._json({
                "t0": out_rows[0][0] if out_rows else None,
                "rows": out_rows,
                "total": total,
                "returned": len(out_rows),
                "truncated": len(out_rows) < total,
            })
            return

        if path == "/plot":
            start = q.get("start", [None])[0]
            end = q.get("end", [None])[0]
            win = q.get("window", [None])[0]
            if end is None and start is None and win:
                end_t = time.time()
                rows = snapshot(end_t - float(win), end_t)
            elif start is not None or end is not None:
                s = float(start) if start else None
                e = float(end) if end else None
                rows = snapshot(s, e)
            else:
                rows = snapshot()
            ch = q.get("ch", [None])[0]
            channels = None
            if ch:
                channels = [int(x) for x in ch.split(",") if x.strip().isdigit()]
            try:
                width = int(q.get("width", ["1400"])[0])
                height = int(q.get("height", ["700"])[0])
            except ValueError:
                width, height = 1400, 700
            normalize = q.get("norm", ["0"])[0] in ("1", "true", "yes")
            title = q.get("title", [None])[0]
            self._png(render_png(rows, channels, width, height, title, normalize))
            return

        if path in ("/", "/index.html"):
            html = ("<html><body style='font-family:sans-serif;padding:24px'>"
                    "<h2>dsh-autoPID bridge</h2>"
                    "<p><a href='/plot?window=5'>最近 5 秒波形</a></p>"
                    "<p><a href='/status'>状态</a> / <a href='/stats'>统计</a></p>"
                    "</body></html>")
            data = html.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return

        self._json({"error": "not found", "path": path}, 404)

    def do_POST(self):
        path = urlparse(self.path).path
        body = self._body()

        if path == "/configure":
            cfg = apply_config(body)
            self._json({"ok": True, **config_snapshot(), "applied": cfg})
            return

        if path == "/set":
            # 下发参数：拼成什么格式由 param_names / set_format 决定
            vals = body.get("values")
            if vals is None:
                vals = []
            line = build_set_line(vals)
            ok, err = write_serial(line.encode("utf-8"))
            self._json({
                "ok": ok,
                "error": err,
                "sent": line.strip(),
                "param_names": list(CFG.get("param_names") or []),
                "set_format": CFG.get("set_format"),
            })
            return

        if path == "/command":
            # 启动 / 停止 / 重来：正文来自配置，谁都能改
            action = str(body.get("action") or "").strip().lower()
            key = {"start": "cmd_start", "stop": "cmd_stop", "reset": "cmd_reset", "restart": "cmd_reset"}.get(action)
            if key is None:
                self._json({"ok": False, "error": f"不认识的指令：{action}（要 start / stop / reset）"}, 400)
                return
            text = str(CFG.get(key) or "").strip()
            if not text:
                self._json({"ok": False, "error": f"{key} 是空的，先去配置里填一行指令"}, 400)
                return
            payload = text if text.endswith("\n") else text + "\n"
            ok, err = write_serial(payload.encode("utf-8"))
            self._json({"ok": ok, "error": err, "sent": payload.strip(), "action": action})
            return

        if path == "/raw":
            data = (body.get("text") or "")
            if not data.endswith("\n"):
                data += "\n"
            ok, err = write_serial(data.encode("utf-8"))
            self._json({"ok": ok, "error": err, "sent": data.strip()})
            return

        if path == "/open":
            # 换串口 / 没插的话切模拟：{"port":"COM3","baud":115200} 或 {"simulate":true}
            if body.get("simulate"):
                mode = start_worker("simulate")
                self._json({"ok": True, "mode": mode})
                return
            port = (body.get("port") or "").strip()
            if not port:
                self._json({"ok": False, "error": "缺少 port"}, 400)
                return
            baud = int(body.get("baud") or 115200)
            if serial is None:
                self._json({"ok": False, "error": "pyserial 未安装"}, 500)
                return
            mode = start_worker("serial", port, baud)
            self._json({"ok": True, "mode": mode, "port": port, "baud": baud})
            return

        if path == "/close":
            stop_worker()
            with LOCK:
                STATUS["connected"] = False
            self._json({"ok": True})
            return

        if path == "/clear":
            with LOCK:
                BUFFER.clear()
            self._json({"ok": True})
            return

        self._json({"error": "not found", "path": path}, 404)


def write_serial(payload: bytes):
    with SERIAL_LOCK:
        ser = SERIAL_OBJ
        if ser is None:
            return False, "serial not open"
        try:
            ser.write(payload)
            ser.flush()
            return True, None
        except Exception as e:
            return False, str(e)


# ---------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", default=None, help="串口名，如 COM3")
    ap.add_argument("--baud", type=int, default=115200)
    ap.add_argument("--http", type=int, default=8765, help="HTTP 端口")
    ap.add_argument("--simulate", action="store_true", help="用假数据自测")
    ap.add_argument("--csv", default="", help="收到的数据追加到这个 .csv；空 = 不落盘")
    ap.add_argument("--channels", type=int, default=0, help="保留前几路，0 = 自动")
    ap.add_argument("--channel-names", default="", help="通道名，逗号分隔，如 L,R,PL,PR")
    ap.add_argument("--param-names", default="", help="参数名，逗号分隔，如 kp,ki,kd")
    ap.add_argument("--set-format", default="", choices=["", "positional", "named"])
    ap.add_argument("--cmd-start", default="", help='启动指令的正文，如 "START"')
    ap.add_argument("--cmd-stop", default="", help='停止指令的正文，如 "STOP"')
    ap.add_argument("--cmd-reset", default="", help='重来指令的正文，如 "RESET"')
    args = ap.parse_args()

    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

    # 命令行给的配置先吃掉；之后 Host 还能用 POST /configure 热改。
    # 空字符串表示"这条不用命令行改"，不然会把默认值（比如 kp,ki,kd）清空。
    boot = {"csv_path": args.csv, "channels": args.channels}
    if args.channel_names:
        boot["channel_names"] = args.channel_names
    if args.param_names:
        boot["param_names"] = args.param_names
    for key in ("cmd_start", "cmd_stop", "cmd_reset"):
        val = getattr(args, key)
        if val:
            boot[key] = val
    if args.set_format:
        boot["set_format"] = args.set_format
    apply_config(boot)
    if CFG["csv_path"]:
        print(f"[bridge] csv -> {CFG['csv_path']}")

    if args.simulate:
        print("[bridge] simulate mode")
        start_worker("simulate")
    elif args.port:
        if serial is None:
            print("[bridge] pyserial 未安装：pip install pyserial", file=sys.stderr)
            sys.exit(2)
        print(f"[bridge] opening {args.port} @ {args.baud}")
        start_worker("serial", args.port, args.baud)
    else:
        print("[bridge] 没有 --port 也没有 --simulate，只跑 HTTP（空数据）")

    srv = ThreadingHTTPServer(("127.0.0.1", args.http), Handler)
    print(f"[bridge] http://127.0.0.1:{args.http}")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        STOP.set()
        stop_worker()
        srv.server_close()


if __name__ == "__main__":
    main()
