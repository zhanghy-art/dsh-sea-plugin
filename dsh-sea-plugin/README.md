# DSH 识海面版 (Sea of Memory)

DSH双层一生感架构 v9.0 的记忆可视化面板。

## 功能

- **中心光球**：金色"本我"节点，带旋转光线和多层光晕
- **记忆节点**：按类型着色（约定=翠绿、高情绪=红、偏好=紫、事件=青、日常=蓝）
- **神经网络连线**：节点间细连线，透明度脉动模拟神经冲动
- **激素仪表盘**：顶部显示皮质醇/多巴胺/催产素/血清素实时数值
- **交互**：拖拽节点、滚轮缩放、点击查看详情、搜索过滤
- **自动刷新**：每15秒从后端拉取最新记忆数据
- **演示模式**：后端未连接时自动加载演示数据，不会白屏

## 安装

### 方式一：一键安装（推荐）

```bash
curl -sSL https://raw.githubusercontent.com/zhanghy-art/dsh-sea-plugin/master/install.sh | bash
```

### 方式二：手动安装

1. Clone仓库到DSH插件目录：
```bash
git clone https://github.com/zhanghy-art/dsh-sea-plugin.git ~/.dsh/profiles/web/sea-of-memory
```

2. 运行安装脚本创建桌面快捷方式：
```bash
cd ~/.dsh/profiles/web/sea-of-memory
./sea/install.bat
```

### 方式三：Windows手动

1. 下载zip并解压到 `~/.dsh/profiles/web/sea-of-memory/`
2. 双击 `sea/install.bat` 创建桌面快捷方式

## 使用

1. 双击桌面「识海」图标
2. 浏览器自动打开 `http://localhost:8765/`
3. 看到记忆图谱

## 文件结构

```
sea-of-memory/
├── plugin.json           # DSH插件清单
├── SKILL.md              # 技能描述
├── README.md             # 本文件
├── install.sh            # 一键安装脚本
├── sea/
│   ├── index.html        # 前端面板
│   ├── start.bat         # 启动脚本
│   └── install.bat       # 创建桌面快捷方式
├── server/
│   └── sea_server.py     # Python后端（零依赖，端口8765）
└── data/
    └── memories.json     # 记忆数据（自动加载）
```

## 技术栈

- **前端**：纯原生Canvas，零外部依赖
- **后端**：Python标准库 http.server，零依赖
- **数据库**：SQLite（自动连接DSH的memories.db）
- **端口**：8765

## API

- `GET /api/sea/nodes` - 获取记忆节点和连线
- `GET /api/sea/hormones` - 获取四大激素实时数值
- `GET /api/sea/stats` - 获取统计信息
- `GET /api/sea/search?q=关键词` - 搜索记忆
- `GET /health` - 健康检查

## 与DSH集成

DSH插件加载时自动识别 `plugin.json`，首次启动提示：

> "是否安装识海面版到桌面？"

用户选择"是" → 自动运行 install.bat → 桌面出现快捷方式。

## 作者

zhanghy-art - https://github.com/zhanghy-art

## License

MIT
