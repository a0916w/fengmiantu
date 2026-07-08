#!/usr/bin/env bash
# fengmiantu 一键部署（Ubuntu/Debian）。
# 用法：先改下面「改这里」的环境变量，再执行： sudo bash deploy.sh
set -euo pipefail

# ===== 改这里 =====
FTP_HOST="ftp.你的图床.com"
FTP_PORT="21"
FTP_USER="xxxxx"
FTP_PASS="xxxxx"
FTP_DIR="/covers"                                  # FTP 远端目录，可留空
FTP_URL_PREFIX="https://cdn.你的图床.com/covers"    # 上面目录对外的 http 前缀（回给 webmm 的图片地址）
COVER_CALLBACK_HOSTS="mm.你的webmm域名.com"          # 防 SSRF：只放行回调到 webmm 域名
PORT="3000"
APP_DIR="/opt/fengmiantu"
REPO="https://github.com/a0916w/fengmiantu.git"
# ==================

# 1. 依赖（ffmpeg 截帧 / node 跑服务）
apt-get update -y
apt-get install -y ffmpeg nodejs git

# 2. 拉代码
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" pull --ff-only
else
  git clone "$REPO" "$APP_DIR"
fi

# 3. systemd 服务（开机自启 + 崩溃重拉）
cat > /etc/systemd/system/fengmiantu.service <<EOF
[Unit]
Description=fengmiantu cover picker
After=network.target

[Service]
WorkingDirectory=$APP_DIR
ExecStart=$(command -v node) server.js
Restart=always
Environment=PORT=$PORT
Environment=FTP_HOST=$FTP_HOST
Environment=FTP_PORT=$FTP_PORT
Environment=FTP_USER=$FTP_USER
Environment=FTP_PASS=$FTP_PASS
Environment=FTP_DIR=$FTP_DIR
Environment=FTP_URL_PREFIX=$FTP_URL_PREFIX
Environment=COVER_CALLBACK_HOSTS=$COVER_CALLBACK_HOSTS

[Install]
WantedBy=multi-user.target
EOF

# 4. 启动
systemctl daemon-reload
systemctl enable --now fengmiantu
sleep 1
systemctl --no-pager status fengmiantu || true

IP=$(hostname -I | awk '{print $1}')
echo "----------------------------------------"
echo "起好了：http://${IP}:${PORT}  （记得安全组放行 ${PORT} 端口）"
echo "改配置后重启： sudo systemctl restart fengmiantu"
echo "看日志：       sudo journalctl -u fengmiantu -f"
