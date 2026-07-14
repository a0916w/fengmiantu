#!/usr/bin/env bash
# fengmiantu 一键部署（Ubuntu/Debian）。 用法： sudo bash deploy.sh
#
# 安全说明：
#  - FTP 密码等秘钥【不写进本脚本、也不写进 systemd unit】（unit 是全局可读的），
#    而是写到 /etc/fengmiantu.env（chmod 600，仅 root 可读），systemd 用 EnvironmentFile 加载。
#  - 服务用专用非 root 用户 fengmiantu 运行（对外服务不该用 root）。
#  - 首次运行若 /etc/fengmiantu.env 不存在，脚本会生成一份【占位模板】，
#    你去把里面的值改成真的、再重跑本脚本即可（真秘钥只留在这台机的 600 文件里，不进 git）。
set -euo pipefail

PORT="3000"
APP_DIR="/opt/fengmiantu"
ENV_FILE="/etc/fengmiantu.env"
SVC_USER="fengmiantu"
REPO="https://github.com/a0916w/fengmiantu.git"

[ "$(id -u)" -eq 0 ] || { echo "请用 root 运行： sudo bash deploy.sh"; exit 1; }

# 1. 依赖（ffmpeg 截帧 / node 跑服务）
apt-get update -y
apt-get install -y ffmpeg nodejs git

# 2. 专用非 root 运行用户
id -u "$SVC_USER" >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin "$SVC_USER"

# 3. 拉代码 —— 以服务账户 $SVC_USER 身份跑 git：属主自己操作既无 dubious-ownership 报错，
# 也不给 root 信任一个服务账户可写的库（否则被埋 .git/hooks 会以 root 执行 = 提权）。
# $SVC_USER 是 nologin 无家目录账户，显式给 HOME=$APP_DIR 供 git 写配置。
install -d -o "$SVC_USER" -g "$SVC_USER" "$APP_DIR"
if [ -d "$APP_DIR/.git" ]; then
  sudo -u "$SVC_USER" env HOME="$APP_DIR" git -C "$APP_DIR" pull --ff-only
else
  sudo -u "$SVC_USER" env HOME="$APP_DIR" git clone "$REPO" "$APP_DIR"
fi
chown -R "$SVC_USER":"$SVC_USER" "$APP_DIR"

# 4. 秘钥文件（600，仅 root）——不存在则生成占位模板并退出让你去填
if [ ! -f "$ENV_FILE" ]; then
  cat > "$ENV_FILE" <<'ENVEOF'
# fengmiantu 秘钥/配置（chmod 600，勿提交 git）。改完真值后重跑 deploy.sh。
FTP_HOST=ftp.你的图床.com
FTP_PORT=21
FTP_USER=xxxxx
FTP_PASS=xxxxx
FTP_DIR=/covers
# 上面 FTP 目录对外的 http 前缀（回给 webmm 的图片地址）
FTP_URL_PREFIX=https://cdn.你的图床.com/covers
# 防 SSRF：只放行回调到 webmm 域名（多个逗号分隔）
COVER_CALLBACK_HOSTS=mm.你的webmm域名.com

# ---- 手动网页「上传到 FTP」按钮 ----
# 上传目标【跟随选中的 logo】：KEY = logo 名。配了 UPLOAD_<KEY>_FTP_HOST 那组，
# 该 logo 就自动出现「上传到」按钮（无需 UPLOAD_TARGETS，自动发现）。
# 值填目标站自己的封面 FTP（如 vodvip 后端的 UPLOAD_FTP_*）：
#   FTP_DIR    = 目标站 {UPLOAD_FTP_BASE_DIR}/covers（会先 CWD 进去，目录须已存在）
#   COVER_PATH = 目标站 /{UPLOAD_COVER_URL_PREFIX}/covers（返回给运营贴进「封面链接」的相对路径前缀）
#   URL_PREFIX = 可选，CDN 完整地址前缀（仅预览用）
# KEY 用 logo 名（vodvip logo → UPLOAD_VODVIP_*）。要限定只启用某些目标可选配 UPLOAD_TARGETS=vodvip,...
UPLOAD_VODVIP_LABEL=vodvip
UPLOAD_VODVIP_FTP_HOST=
UPLOAD_VODVIP_FTP_PORT=21
UPLOAD_VODVIP_FTP_USER=
UPLOAD_VODVIP_FTP_PASS=
UPLOAD_VODVIP_FTP_DIR=/covers
UPLOAD_VODVIP_COVER_PATH=/covers
UPLOAD_VODVIP_URL_PREFIX=
# 默认(兜底)目标：logo 没配专属 FTP 时用它（如 mm/mmchigua 等）。字段同上。
# 不填 UPLOAD_DEFAULT_* 则自动退回上面的 FTP_*（webmm 那台）。都没有则该 logo 不显示上传按钮。
UPLOAD_DEFAULT_LABEL=默认
UPLOAD_DEFAULT_FTP_HOST=
UPLOAD_DEFAULT_FTP_USER=
UPLOAD_DEFAULT_FTP_PASS=
UPLOAD_DEFAULT_FTP_DIR=
UPLOAD_DEFAULT_COVER_PATH=
ENVEOF
  chmod 600 "$ENV_FILE"
  chown root:root "$ENV_FILE"
  echo ">>> 已生成占位配置 $ENV_FILE ——请编辑填入真实 FTP/webmm 值，然后重跑： sudo bash deploy.sh"
  exit 0
fi
chmod 600 "$ENV_FILE"

# 5. systemd 服务（非 root 运行 + 秘钥走 EnvironmentFile，不进全局可读的 unit）
cat > /etc/systemd/system/fengmiantu.service <<EOF
[Unit]
Description=fengmiantu cover picker
After=network.target

[Service]
User=$SVC_USER
WorkingDirectory=$APP_DIR
ExecStart=$(command -v node) server.js
Restart=always
Environment=PORT=$PORT
EnvironmentFile=$ENV_FILE
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

# 6. 启动
systemctl daemon-reload
systemctl enable --now fengmiantu
sleep 1
systemctl --no-pager status fengmiantu || true

IP=$(hostname -I | awk '{print $1}')
echo "----------------------------------------"
echo "起好了：http://${IP}:${PORT}  （记得安全组放行 ${PORT} 端口）"
echo "改配置：编辑 $ENV_FILE 后  sudo systemctl restart fengmiantu"
echo "看日志：sudo journalctl -u fengmiantu -f"
