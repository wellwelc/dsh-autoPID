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
                with LOCK:
                    if CHANNEL_COUNT == 0:
                        CHANNEL_COUNT = len(vals)
                    STATUS["lines"] += 1
                    STATUS["last_line"] = raw.decode("utf-8", errors="ignore").strip()[:200]
                    BUFFER.append((time.time(), vals))
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
        with LOCK:
            BUFFER.append((time.time(), vals))
            STATUS["lines"] += 1
            STATUS["last_line"] = ",".join(str(v) for v in vals)
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
            st.update(worker_state())
            self._json(st)
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

        if path == "/set":
            # 下发参数：body 形状随意，这里只把数字拼成 "SET kp ki kd\n"
            vals = body.get("values")
            if vals is None:
                vals = []
            line = "SET " + " ".join(str(v) for v in vals) + "\n"
            ok, err = write_serial(line.encode("utf-8"))
            self._json({"ok": ok, "error": err, "sent": line.strip()})
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
    args = ap.parse_args()

    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

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
