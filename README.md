# 智能封面图

粘贴 m3u8 视频链接，自动智能选帧截图，三张拼成一张封面图。

## 依赖

- Node.js
- ffmpeg / ffprobe（`brew install ffmpeg`）
- `@napi-rs/canvas`（服务端拼图，预编译二进制）——`npm i`

## 启动

```bash
npm i
node server.js          # 默认 http://localhost:3000
PORT=3737 node server.js  # 指定端口
```

测试：`npm test`（`node --test`）。

## 功能

- **智能选帧**：掐掉片头片尾各 8%，中间均分 10 段随机取点；每个点用 ffmpeg 的 `thumbnail` 滤镜在 25 帧里挑最有代表性的一帧，自动避开黑屏和转场画面
- **10 张候选，手选 3 张**：默认选中前 3 张，点击卡片切换选择，「已选顺序」条上可用 ←/→ 调整拼接顺序（1号=大图位），单张可「换一帧」，也可「全部换一批」；截图限 6 路并发
- **六种拼接布局**：横排 / 1大2小 / 2小1大 / 上1下2 / 中间大 / 斜切；内部按 1280×720 合成，导出 640×360 WebP（不支持 WebP 的浏览器自动降级 JPG），约 20–60KB，适合手机双列列表页
- **双预览**：整张大图 + 模拟手机双列效果
- **顶部去水印**：按帧高比例裁掉每帧顶部（0 / 2.5% / 5% / 7.5%，默认 7.5%）
- **左上角 Logo 水印**（可关，带投影轮廓）
- 支持直播流（无时长时从头部选帧）

## 接口

### 手动工具（浏览器 canvas 拼图）

| 接口 | 说明 |
| --- | --- |
| `POST /api/probe` `{url}` | 探测视频时长 |
| `POST /api/frame` `{url, duration, index, count}` | 截取第 index 段的一帧，返回 base64 图片和时间点 |
| `POST /api/publish` `{image, external_id, callback}` | 上传浏览器合成的成品并回调 |

### 多项目封面 API（异步 + 回调，服务端拼图）

供其它项目调用：传视频链接 + 指定 logo，服务端自动抽默认 3 帧、拼图、叠该项目 logo，上传后把结果 URL 回调回去。

| 接口 | 说明 |
| --- | --- |
| `POST /api/cover` `Bearer <项目token>` `{url, logo?, external_id?, callback}` | 建任务入队，立即返回 `{ ok, job_id }`；缺 `logo` 用项目默认，`logo:"none"` 不叠 |
| `GET /api/cover/:id` `Bearer <项目token>` | 查任务状态 `{ status, resultUrl, error }` |

回调（服务端 → 调用方 `callback`）：
- 成功 `{ status:"completed", job_id, external_id, url }`
- 失败 `{ status:"failed", job_id, external_id, error }`

抽帧/拼图受全局 ffmpeg 并发闸限制（`FFMPEG_MAX_CONCURRENCY`），队列并发 `FENGMIANTU_CONCURRENCY`。

## 后台（需 `ADMIN_TOKEN`，`?token=` 或 `Authorization: Bearer`）

| 页面 | 说明 |
| --- | --- |
| `/queue` | 队列/任务列表：项目、状态、结果缩略图、失败原因 |
| `/projects` | 项目管理：新建（生成 token）、设默认 logo、重置 token、删除 |
| `/logos` | logo 管理：网页上传/替换/删除 PNG + 预览 |

多项目用法：先在 `/logos` 传各项目 logo，再在 `/projects` 建项目并选默认 logo，拿到 token 给该项目调用 `/api/cover`。
