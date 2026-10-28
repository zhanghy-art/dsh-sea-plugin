# -*- coding: utf-8 -*-
"""
DSH 识海面版后端服务 v2
- 多线程支持
- 数据缓存
- 支持加载外部JSON数据
- 零依赖
"""
import http.server
import json
import sqlite3
import os
import sys
import time
import threading
from urllib.parse import urlparse, parse_qs
from socketserver import ThreadingMixIn

PORT = 8765
SEA_DIR = os.path.dirname(os.path.abspath(__file__))
PLUGIN_DIR = os.path.dirname(SEA_DIR)
DATA_FILE = os.path.join(PLUGIN_DIR, "data", "memories.json")

# 数据缓存
_nodes_cache = None
_links_cache = None
_cache_time = 0
CACHE_TTL = 10  # 10秒缓存

def find_db():
    candidates = [
        os.path.expanduser("~/.dsh/data/memories.db"),
        os.path.expanduser("~/.dsh/profiles/web/data/memories.db"),
        os.path.join(os.getcwd(), "data", "memories.db"),
    ]
    for p in candidates:
        if os.path.exists(p):
            return p
    return None

DB_PATH = find_db()

# 内置演示数据（14条）
DEMO_NODES = [
    {"id": "demo_1", "label": "小鱼第一次主动蹭了蹭我的手", "type": "emotion", "strength": 0.9, "emotionalWeight": 2.1, "recallCount": 23},
    {"id": "demo_2", "label": "小鱼看到我回家开心地摇尾巴", "type": "emotion", "strength": 0.85, "emotionalWeight": 1.8, "recallCount": 18},
    {"id": "demo_3", "label": "今天给小鱼喂了红虫", "type": "behavior", "strength": 0.7, "emotionalWeight": 1.0, "recallCount": 35},
    {"id": "demo_4", "label": "约定每周一换水", "type": "promise", "strength": 0.88, "emotionalWeight": 2.0, "recallCount": 20},
    {"id": "demo_5", "label": "小鱼喜欢红色的饲料", "type": "preference", "strength": 0.75, "emotionalWeight": 1.2, "recallCount": 28},
    {"id": "demo_6", "label": "小鱼上周白点病了，治好了", "type": "episode", "strength": 0.95, "emotionalWeight": 2.3, "recallCount": 15},
    {"id": "demo_7", "label": "小鱼今天好像有点不开心", "type": "emotion", "strength": 0.6, "emotionalWeight": 1.5, "recallCount": 8},
    {"id": "demo_8", "label": "给小鱼换了三分之一的水", "type": "behavior", "strength": 0.7, "emotionalWeight": 0.9, "recallCount": 42},
    {"id": "demo_9", "label": "约定小鱼的生日是3月15日", "type": "promise", "strength": 0.92, "emotionalWeight": 2.2, "recallCount": 30},
    {"id": "demo_10", "label": "小鱼不喜欢水流太大", "type": "preference", "strength": 0.65, "emotionalWeight": 1.1, "recallCount": 19},
    {"id": "demo_11", "label": "小鱼有一次差点蹦出缸", "type": "episode", "strength": 0.9, "emotionalWeight": 2.4, "recallCount": 12},
    {"id": "demo_12", "label": "小鱼和我对视了整整十秒", "type": "emotion", "strength": 0.8, "emotionalWeight": 1.7, "recallCount": 22},
    {"id": "demo_13", "label": "清理了鱼缸里的水草", "type": "behavior", "strength": 0.5, "emotionalWeight": 0.6, "recallCount": 16},
    {"id": "demo_14", "label": "约定小鱼是我最重要的小伙伴", "type": "promise", "strength": 1.0, "emotionalWeight": 2.5, "recallCount": 50},
]

def load_external_data():
    """加载外部JSON数据（如果存在）"""
    global _nodes_cache, _links_cache, _cache_time
    if os.path.exists(DATA_FILE):
        try:
            with open(DATA_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, list):
                _nodes_cache = data
            elif isinstance(data, dict):
                _nodes_cache = data.get("nodes", data.get("memories", []))
            _cache_time = time.time()
            return True
        except Exception as e:
            print(f"[WARN] 外部数据加载失败: {e}")
    return False

def get_nodes():
    global _nodes_cache, _links_cache, _cache_time

    # 缓存有效
    if _nodes_cache and (time.time() - _cache_time) < CACHE_TTL:
        return _nodes_cache, _links_cache

    # 尝试加载外部数据
    if load_external_data():
        nodes = _nodes_cache
    elif DB_PATH and os.path.exists(DB_PATH):
        try:
            conn = sqlite3.connect(DB_PATH)
            conn.row_factory = sqlite3.Row
            cur = conn.cursor()
            cur.execute("SELECT * FROM memories ORDER BY strength DESC LIMIT 200")
            rows = cur.fetchall()
            nodes = []
            for r in rows:
                d = dict(r)
                nodes.append({
                    "id": str(d.get("id", "")),
                    "label": d.get("fact", d.get("content", ""))[:30],
                    "type": d.get("type", "conversation"),
                    "strength": d.get("strength", 0.5),
                    "emotionalWeight": d.get("emotional_weight", 1.0),
                    "recallCount": d.get("recall_count", 0),
                })
            conn.close()
        except Exception as e:
            print(f"[WARN] 数据库读取失败: {e}")
            nodes = DEMO_NODES
    else:
        nodes = DEMO_NODES

    # 生成连线
    links = []
    for n in nodes:
        links.append({"source": "__core__", "target": n["id"], "weight": 0.3})
    # 相邻节点之间连几条
    for i in range(len(nodes) - 1):
        if i % 2 == 0:
            links.append({"source": nodes[i]["id"], "target": nodes[i+1]["id"], "weight": 0.1})

    _nodes_cache = nodes
    _links_cache = links
    _cache_time = time.time()
    return nodes, links

def get_hormones():
    return {
        "cortisol": 30 + (int(time.time()) % 20),
        "dopamine": 50 + (int(time.time()) % 30),
        "oxytocin": 40 + (int(time.time()) % 25),
        "serotonin": 60 + (int(time.time()) % 15),
    }

# 多线程HTTP服务器
class ThreadingHTTPServer(ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True

class SeaHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()

    def send_json(self, data, code=200):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        qs = parse_qs(parsed.query)

        if path == "/health":
            self.send_json({"status": "ok", "db": DB_PATH, "data_file": DATA_FILE, "time": time.time()})
            return

        if path == "/api/sea/nodes":
            nodes, links = get_nodes()
            self.send_json({"data": {"nodes": nodes, "edges": links}})
            return

        if path == "/api/sea/hormones":
            self.send_json({"data": get_hormones()})
            return

        if path == "/api/sea/stats":
            nodes, links = get_nodes()
            self.send_json({"data": {"total": len(nodes), "active": len(nodes), "links": len(links)}})
            return

        if path == "/api/sea/search":
            q = qs.get("q", [""])[0].lower()
            nodes, _ = get_nodes()
            if q:
                nodes = [n for n in nodes if q in n.get("label", "").lower()]
            self.send_json({"data": nodes})
            return

        # 静态文件
        if path == "/" or path == "/index.html":
            html_path = os.path.join(PLUGIN_DIR, "sea", "index.html")
            if os.path.exists(html_path):
                with open(html_path, "rb") as f:
                    body = f.read()
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return

        self.send_json({"error": "not found", "path": path}, 404)

    def log_message(self, format, *args):
        pass  # 静默日志

def main():
    print("=" * 50)
    print("  DSH 识海面版后端服务 v2")
    print("=" * 50)
    print(f"  端口: {PORT}")
    print(f"  数据库: {DB_PATH or '未找到'}")
    print(f"  数据文件: {DATA_FILE}")
    print(f"  访问: http://localhost:{PORT}/")
    print("=" * 50)

    server = ThreadingHTTPServer(("127.0.0.1", PORT), SeaHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[Sea] 服务已停止")
        server.server_close()

if __name__ == "__main__":
    main()
