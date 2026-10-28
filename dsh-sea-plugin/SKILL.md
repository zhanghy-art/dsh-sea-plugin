---
name: sea-of-memory
description: |
  识海面版（Sea of Memory）- DSH双层一生感架构的记忆可视化面板。
  提供中心光球式的记忆图谱可视化，支持按类型着色、激素状态显示、
  节点拖拽缩放、搜索过滤和自动刷新。用户想"看看我的记忆""打开识海"
  时使用此面板。
version: 9.0
category: visualization
---

# 识海面版（Sea of Memory）

DSH双层一生感架构v9.0的可视化面板。

## 功能

- **中心光球**：金色"本我"节点，带旋转光线和多层光晕
- **记忆节点**：按类型着色（约定=翠绿、高情绪=红、偏好=紫、事件=青、日常=蓝）
- **神经网络连线**：节点间细连线，透明度脉动模拟神经冲动
- **激素仪表盘**：顶部显示皮质醇/多巴胺/催产素/血清素实时数值
- **交互**：拖拽节点、滚轮缩放、点击查看详情、搜索过滤
- **自动刷新**：每15秒从后端拉取最新记忆数据
- **演示模式**：后端未连接时自动加载演示数据，不会白屏

## 使用方式

用户说"打开识海""看看我的记忆"时：

1. 运行 `sea/start.bat`（Windows）或启动Python后端
2. 浏览器自动打开 `http://localhost:8765/`
3. 面板自动连接后端，展示实时记忆网络

## 安装到桌面

首次使用时运行 `sea/install.bat`，自动在桌面创建"识海"快捷方式。

## API

- `GET /api/sea/nodes` - 获取记忆节点和连线
- `GET /api/sea/hormones` - 获取四大激素实时数值
- `GET /api/sea/stats` - 获取统计信息
- `GET /api/sea/search?q=关键词` - 搜索记忆
- `GET /health` - 健康检查

## 文件结构

```
sea-of-memory/
├── SKILL.md              # 本文件
├── sea/
│   ├── index.html        # 前端面板
│   ├── start.bat         # 启动脚本（Windows）
│   └── install.bat       # 安装到桌面
├── server/
│   └── sea_server.py     # Python后端（零依赖）
└── README.md
```
