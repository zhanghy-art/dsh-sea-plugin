# DSH 识海面版（Sea of Memory）

DSH双层一生感架构v9.0 的记忆可视化面板。

## 快速开始

### Windows

1. 双击 `sea\start.bat`
2. 浏览器自动打开 `http://localhost:8765/`
3. 看到记忆图谱

### 安装到桌面

1. 双击 `sea\install.bat`
2. 桌面出现「识海」快捷方式
3. 以后双击桌面图标就能打开

## 功能清单

| 功能 | 状态 |
|---|---|
| 中心光球 + 旋转光线 | ✅ |
| 记忆节点 + 类型着色 | ✅ |
| 神经网络连线（脉动效果） | ✅ |
| 激素仪表盘（皮质醇/多巴胺/催产素/血清素） | ✅ |
| 拖拽节点 / 滚轮缩放 / 点击详情 | ✅ |
| 搜索过滤 | ✅ |
| 自动刷新（15秒） | ✅ |
| 对接DSH记忆数据库（SQLite） | ✅ |
| 演示模式（后端未连接时） | ✅ |

## 技术栈

- **前端**：纯原生Canvas，零外部依赖，不需要CDN
- **后端**：Python标准库 http.server，零依赖
- **数据库**：SQLite（自动连接DSH的memories.db）
- **端口**：8765

## 与DSH集成

DSH插件安装完成后，首次启动时提示：

> "是否安装识海面版？安装后可在桌面双击图标查看记忆图谱。"

用户选择"是" → 自动运行 install.bat → 桌面出现快捷方式。

## 文件结构

```
dsh-sea-plugin/
├── SKILL.md              # DSH插件描述
├── README.md              # 本文件
├── sea/
│   ├── index.html        # 前端面板
│   ├── start.bat         # 启动脚本
│   └── install.bat       # 安装到桌面
└── server/
    └── sea_server.py     # Python后端
```

## 部署到DSH

把整个 `dsh-sea-plugin` 文件夹复制到：

```
~/.dsh/profiles/web/sea-of-memory/
```

DSH会自动识别SKILL.md并加载此插件。
