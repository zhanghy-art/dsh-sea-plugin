#!/bin/bash
# DSH 识海面版一键安装脚本
# 用法: curl -sSL https://raw.githubusercontent.com/zhanghy-art/dsh-sea-plugin/master/install.sh | bash

set -e

echo "========================================"
echo "  DSH 识海面版安装程序"
echo "========================================"
echo ""

# DSH插件目录
PLUGIN_DIR="$HOME/.dsh/profiles/web/sea-of-memory"

# 创建目录
mkdir -p "$PLUGIN_DIR"

# 下载仓库
echo "[1/4] 下载插件文件..."
git clone https://github.com/zhanghy-art/dsh-sea-plugin.git "$PLUGIN_DIR/tmp" 2>/dev/null || {
    echo "git clone 失败，请检查网络"
    exit 1
}
mv "$PLUGIN_DIR/tmp/"* "$PLUGIN_DIR/"
rm -rf "$PLUGIN_DIR/tmp"

echo "[2/4] 安装完成"
echo ""

# 询问是否安装到桌面
read -p "是否安装桌面快捷方式？(y/n) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo "[3/4] 创建桌面快捷方式..."
    DESKTOP_DIR="$HOME/Desktop"
    cat > "$DESKTOP_DIR/识海.desktop" << EOF
[Desktop Entry]
Name=识海
Comment=DSH 记忆可视化面板
Exec=$PLUGIN_DIR/sea/start.bat
Type=Application
EOF
    chmod +x "$DESKTOP_DIR/识海.desktop"
    echo "  桌面快捷方式已创建"
else
    echo "[3/4] 跳过桌面快捷方式"
fi

echo ""
echo "[4/4] 完成！"
echo ""
echo "使用方法："
echo "  双击桌面「识海」图标，或运行："
echo "  $PLUGIN_DIR/sea/start.bat"
echo ""
echo "访问地址: http://localhost:8765/"
echo ""
