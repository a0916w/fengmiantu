# fengmiantu 部署（手动选封面工具）

Node 服务（`server.js` + `lib/` + `index.html` + `logo.png`），一个 npm 依赖 `@napi-rs/canvas`
（服务端拼图），本机装 Node + ffmpeg。两种用法：
- **手动工具**：webmm 后台「手动选封面」跳到这里，浏览器挑帧拼图 → 上传 FTP → 回写 webmm。
- **多项目 API**：其它项目 `POST /api/cover` 传视频链接 + logo，服务端自动抽 3 帧拼图 → 上传 FTP →
  回调结果 URL。后台 `/queue` `/projects` `/logos` 管理任务、项目、logo。

## 1. 前置

服务器（另一台机器，能被运营浏览器 + webmm 服务器访问）装好：

```bash
node -v      # >= 16 即可
ffmpeg -version && ffprobe -version   # 没有就装：apt install -y ffmpeg  /  yum install -y ffmpeg

# 「自动去文字」功能的 OCR（可选但推荐；不装则该功能自动关闭，其余不受影响）
apt install -y tesseract-ocr tesseract-ocr-chi-sim   # yum: tesseract + tesseract-langpack-chi_sim
tesseract --list-langs                                # 确认列表里有 chi_sim
```

## 2. 放代码

把整个仓库拷到服务器（如 `/opt/fengmiantu/`），装依赖：

```bash
git clone <repo> /opt/fengmiantu && cd /opt/fengmiantu
npm i                     # 装 @napi-rs/canvas（预编译，无需编译工具）
```

`data/`（任务/项目 JSON）是运行时可写目录，**部署时勿覆盖**（已在 `.gitignore`）。
`logos/` 随仓库走（git 管理），后台上传的新 logo 记得在开发机同步提交，否则发版会少。
发版更新：`git pull && npm i && 重启服务`。

## 3. 配环境变量

上传 FTP + 回写地址（必填），SSRF 白名单（强烈建议）：

```bash
# —— 上传封面的 FTP（挑好的封面存这里）——
export FTP_HOST=ftp.你的图床.com
export FTP_PORT=21
export FTP_USER=xxxxx
export FTP_PASS=xxxxx
export FTP_DIR=/covers                       # 远端目录，可留空

# —— 回写给 webmm 的图片地址前缀（= 上面 FTP 目录对外的 HTTP 前缀）——
export FTP_URL_PREFIX=https://cdn.你的图床.com/covers

# —— 防 SSRF：只允许回调到 webmm 域名（多个逗号分隔）——
export COVER_CALLBACK_HOSTS=mm.你的webmm域名.com

# —— 端口（可选，默认 3000）——
export PORT=3000

# —— 多项目 API + 后台（新）——
export ADMIN_TOKEN=<强随机串>          # 访问 /queue /projects /logos 及管理 API 的口令
export FENGMIANTU_CONCURRENCY=2        # 队列并发（同时处理几个封面任务）
export FFMPEG_MAX_CONCURRENCY=4        # 全局 ffmpeg 抽帧并发闸（手动+队列合计上限）
# export DATA_DIR=/opt/fengmiantu/data   # 可选，默认项目目录下 data/
# export LOGOS_DIR=/opt/fengmiantu/logos # 可选，默认项目目录下 logos/
```

> 上传后 `FTP_DIR` 里的文件，用 `FTP_URL_PREFIX + / + 文件名` 拼成公开 URL 回给 webmm。
> 二者要对得上（同一批文件既能 FTP 写、又能 HTTP 读）。
> `COVER_CALLBACK_ALLOW_LOOPBACK` / `COVER_UPLOAD_STUB_DIR` 只给测试用，**生产别设**。

## 4. 起服务（选一种）

**systemd（推荐，开机自启+崩溃重拉）** `/etc/systemd/system/fengmiantu.service`：

```ini
[Unit]
Description=fengmiantu cover picker
After=network.target

[Service]
WorkingDirectory=/opt/fengmiantu
ExecStart=/usr/bin/node server.js
Restart=always
Environment=PORT=3000
Environment=FTP_HOST=ftp.你的图床.com
Environment=FTP_USER=xxxxx
Environment=FTP_PASS=xxxxx
Environment=FTP_DIR=/covers
Environment=FTP_URL_PREFIX=https://cdn.你的图床.com/covers
Environment=COVER_CALLBACK_HOSTS=mm.你的webmm域名.com
Environment=ADMIN_TOKEN=强随机串
Environment=FENGMIANTU_CONCURRENCY=2
Environment=FFMPEG_MAX_CONCURRENCY=4

[Install]
WantedBy=multi-user.target
```

> systemd 里 `ExecStart` 前确保已 `npm i`（node_modules 就位）。发版：`git pull && npm i &&
> systemctl restart fengmiantu`。

```bash
systemctl daemon-reload && systemctl enable --now fengmiantu
systemctl status fengmiantu     # 看是否 running
```

**或 pm2**：`pm2 start server.js --name fengmiantu && pm2 save`
**或临时**：`nohup node server.js > fm.log 2>&1 &`

## 5. 对外暴露（nginx 反代 + HTTPS）

运营和 webmm 要能用域名访问。nginx 示例：

```nginx
server {
    listen 443 ssl;
    server_name fengmiantu.你的域名.com;
    # ssl_certificate ...;
    client_max_body_size 8m;          # 封面 dataURL 上传，放开限制
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_read_timeout 180s;      # 截帧/上传较慢，别太短
    }
}
```

## 6. 配 webmm（让后台按钮指向这里）

webmm 的 `.env` 加两个：

```bash
COVER_PICKER_URL=https://fengmiantu.你的域名.com     # 第 5 步的域名
MEDIA_PLAY_DOMAIN=https://播放域名                     # 把库里相对 video_url 拼成完整 m3u8
```

改完 webmm 清缓存：`php artisan config:clear`

## 7. 验证

1. 直接访问 `https://fengmiantu.你的域名.com/` —— 能打开挑帧页 = 服务 OK
2. webmm 后台 media-videos 列表 → 某视频操作菜单点「手动选封面」→ 新标签打开 fengmiantu 且
   m3u8 自动填好、自动开始选帧
3. 挑 3 帧 → 拼好 → 点绿色「用作封面」→ 提示「封面已更新」→ 回 webmm 刷新，封面已换

排查：服务端日志看 `[publish]`；回调打不通先确认 `COVER_CALLBACK_HOSTS` 填的是 webmm 域名；
FTP 传失败看 `FTP_*` 是否正确、目录是否可写。
