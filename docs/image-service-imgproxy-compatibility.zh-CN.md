# SupaCloud 图片服务与 imgproxy / imgproxy Pro 兼容性对照

本文说明 SupaCloud 原生图片服务（`supacloud-image`，基于 `@napi-rs/image`）对 imgproxy URL 协议、处理选项、Info 接口和部署方式的兼容程度，并给出迁移与差距说明。

## 结论

SupaCloud 图片服务已经实现 imgproxy 的核心 URL 协议和绝大多数日常处理能力：

- 兼容 `/:signature/:options/:source`、`/info/:signature/:options/:source`、`plain`、Base64、`enc` 和 `@ext` / `.ext` 扩展名。
- 兼容 HMAC-SHA256 签名、多组 key/salt、`IMGPROXY_TRUSTED_SIGNATURES`、签名长度、Bearer 鉴权、CORS、`expires`、`hashsum`、`fallback_image_url`、`presets`。
- 支持 HTTP(S)、data URI、本地文件和加密源，不支持 S3/GCS/Azure/Swift 原生源，但可以通过预签名 URL 间接访问。
- 支持 JPEG、PNG、WebP、AVIF、GIF、BMP、TIFF、ICO 输出，支持 JPEG/PNG/WebP/AVIF/JXL/BMP/TIFF/ICO/SVG/GIF 输入。
- 保留原有 Thumbor 风格 POST API 和管理 API，不改变现有调用方。

它适合作为 imgproxy OSS 的日常替代，尤其是“对象存储 + CDN + 签名缩略图”的场景。imgproxy Pro 的视频缩略图、PDF、ONNX 物体检测/分类、C2PA 等能力不在当前实现范围内，相关选项会返回 `422`，不会静默产出错误结果。

## URL 与签名

### 处理 URL

```text
/:signature/:options/:source
/info/:signature/:options/:source
```

签名计算方式与 imgproxy 一致：

```text
signature = base64url(HMAC-SHA256(key, salt + path))
```

其中 `path` 是签名之后、查询参数之前的路径。例如：

```text
/rs:fit:300:300/g:ce/plain/http://example.com/image.jpg@webp
```

生成签名：

```ts
import { createHmac } from "node:crypto";

const key = Buffer.from("736563726574", "hex");
const salt = Buffer.from("68656C6C6F", "hex");
const path = "/rs:fit:300:300/g:ce/plain/http://example.com/image.jpg@webp";

const signature = createHmac("sha256", key)
  .update(salt)
  .update(path)
  .digest("base64url");
```

如果配置了 `IMGPROXY_SIGNATURE_SIZE`，取 HMAC 摘要的前 N 字节再做 base64url。

### 源 URL 形式

| 形式 | 示例 | 说明 |
| --- | --- | --- |
| `plain` | `/plain/http://example.com/a.jpg@webp` | 明文 URL，`@webp` 指定输出格式 |
| Base64 | `/aHR0cDovL2V4YW1wbGUuY29tL2EuanBn.webp` | Base64url 源 URL，`.webp` 指定输出格式 |
| `enc` | `/enc/<base64url>` | AES-CBC 加密源 URL，需配置加密 key |
| data URI | Base64 编码后作为源 | 适合小图和内联测试 |
| 本地文件 | `/plain/local://path/to/a.jpg` | 需配置 `IMGPROXY_LOCAL_FILESYSTEM_ROOT` |

本地源必须使用 `plain/local://...`，否则 `local:` 会被解析成处理选项。

### Info 接口

```text
/info/:signature/:source
/info/:signature/:info_options/:source
```

示例：

```text
/info/<signature>/plain/http://example.com/a.jpg
/info/<signature>/exif:0/dominant_colors:1/plain/http://example.com/a.jpg
```

默认返回 `size`、`format`、`dimensions`、`orientation`、`exif` 和 `colorspace`。

## 功能矩阵

图例：`是` 表示已支持；`近似` 表示行为接近但算法或边界不同；`部分` 表示只覆盖常见子集；`否` 表示未实现。

### 源与访问控制

| 能力 | imgproxy OSS | imgproxy Pro | SupaCloud | 说明 |
| --- | --- | --- | --- | --- |
| HTTP(S) 源 | 是 | 是 | 是 | 支持重定向、超时、User-Agent |
| data URI 源 | 是 | 是 | 是 | |
| 本地文件源 | 是 | 是 | 是 | 需 `IMGPROXY_LOCAL_FILESYSTEM_ROOT` |
| `plain` / Base64 / `enc` 源 | 是 | 是 | 是 | `enc` 使用 AES-CBC |
| S3 原生源 | 是 | 是 | 否 | 可用预签名 URL |
| GCS 原生源 | 是 | 是 | 否 | |
| Azure Blob 原生源 | 否 | 是 | 否 | |
| OpenStack Swift 原生源 | 否 | 是 | 否 | |
| `IMGPROXY_BASE_URL` | 是 | 是 | 是 | |
| `IMGPROXY_ALLOWED_SOURCES` | 是 | 是 | 是 | 支持 `*` 通配 |
| 环回/私网/链路本地 SSRF 开关 | 是 | 是 | 是 | 默认允许私网，便于内网 MinIO |
| 源 URL 加密 | 是 | 是 | 是 | `IMGPROXY_SOURCE_URL_ENCRYPTION_KEY` |
| 源大小/分辨率限制 | 是 | 是 | 是 | |
| 重定向次数限制 | 是 | 是 | 是 | 最多 5 次 |

### 签名、鉴权与缓存

| 能力 | imgproxy OSS | imgproxy Pro | SupaCloud | 说明 |
| --- | --- | --- | --- | --- |
| HMAC-SHA256 签名 | 是 | 是 | 是 | |
| 多组 key/salt | 是 | 是 | 是 | 逗号分隔 |
| `IMGPROXY_TRUSTED_SIGNATURES` | 是 | 是 | 是 | |
| `IMGPROXY_SIGNATURE_SIZE` | 是 | 是 | 是 | 1-32 字节 |
| Bearer 鉴权 | 是 | 是 | 是 | `IMGPROXY_SECRET` |
| CORS | 是 | 是 | 是 | `IMGPROXY_ALLOW_ORIGIN` |
| `expires` | 是 | 是 | 是 | 过期返回 404 |
| `hashsum` | 是 | 是 | 是 | MD5/SHA1/SHA256/SHA512；`raw` 流式不校验 |
| `fallback_image_url` | 是 | 是 | 是 | 源失败时返回兜底图 |
| `presets` / `IMGPROXY_ONLY_PRESETS` | 是 | 是 | 是 | 支持 `default` 预设 |
| `raw` | 是 | 是 | 是 | 流式返回源文件 |
| `skip_processing` | 是 | 是 | 是 | 按源格式跳过 |
| `cachebuster` | 是 | 是 | 是 | 参与签名，不做缓存键 |
| `bypass_cache` / `cache_tags` | 是 | 是 | 否 | 无内部结果缓存 |
| `Cache-Control` | 是 | 是 | 是 | `IMGPROXY_CACHE_CONTROL` |
| 内部结果缓存 | 是 | 是 | 否 | 建议交给 CDN |
| Prometheus 指标 | 是 | 是 | 否 | |

### 尺寸与几何

| 能力 | imgproxy OSS | imgproxy Pro | SupaCloud | 说明 |
| --- | --- | --- | --- | --- |
| `fit` / `fill` / `fill-down` / `force` / `auto` | 是 | 是 | 是 | `fill-down` 为近似实现 |
| `enlarge` | 是 | 是 | 是 | |
| `extend` / `extend_aspect_ratio` | 是 | 是 | 是 | |
| `width` / `height` / `min-width` / `min-height` | 是 | 是 | 是 | |
| `zoom` / `dpr` | 是 | 是 | 是 | |
| `gravity` 基础方向 | 是 | 是 | 是 | `no/so/ea/we/noea/nowe/soea/sowe/ce/fp` |
| `gravity:sm` 智能裁剪 | 是 | 是 | 是 | 基于 saliency |
| `gravity:obj` / `objw` | 否 | 是 | 近似 | 使用 saliency，不是 ONNX |
| `crop` / `crop_aspect_ratio` | 是 | 是 | 是 | |
| `trim` | 是 | 是 | 近似 | 角点平均色作为背景 |
| `padding` | 是 | 是 | 是 | |
| `background` / `background_alpha` | 是 | 是 | 是 | |
| `rotate` / `flip` / `auto_rotate` | 是 | 是 | 是 | 旋转按 90 度步进 |
| `resizing_algorithm` | 是 | 是 | 是 | 映射到 napi-rs filter |
| `max_result_dimension` | 是 | 是 | 是 | |

### 滤镜与水印

| 能力 | imgproxy OSS | imgproxy Pro | SupaCloud | 说明 |
| --- | --- | --- | --- | --- |
| `brightness` / `contrast` / `saturation` | 是 | 是 | 是 | |
| `blur` / `sharpen` / `pixelate` | 是 | 是 | 是 | |
| `unsharp_masking` | 是 | 是 | 是 | |
| `monochrome` / `duotone` | 是 | 是 | 是 | |
| `colorize` / `gradient` | 是 | 是 | 是 | |
| `blur_areas` | 是 | 是 | 是 | 坐标为 0-1 相对值 |
| `progressive_blur` | 视版本 | 是 | 是 | 方向 0-3，支持起止位置 |
| `grayscale` / `invert` | 是 | 是 | 是 | |
| 图片水印 | 是 | 是 | 是 | URL 或请求体 |
| 文字水印 | 是 | 是 | 是 | 去除 Pango markup |
| 水印位置/偏移/缩放/透明度 | 是 | 是 | 是 | |
| 水印平铺 | 是 | 是 | 是 | `re` / `ch` |
| 水印旋转 | 是 | 是 | 部分 | 90 度步进 |
| 水印阴影 | 是 | 是 | 近似 | |
| 水印宽高 | 是 | 是 | 是 | |
| Pango 富文本水印 | 是 | 是 | 否 | |

### 编码与质量

| 能力 | imgproxy OSS | imgproxy Pro | SupaCloud | 说明 |
| --- | --- | --- | --- | --- |
| JPEG 输出 | 是 | 是 | 是 | |
| PNG 输出 | 是 | 是 | 是 | |
| WebP 输出 | 是 | 是 | 是 | |
| AVIF 输出 | 是 | 是 | 是 | |
| GIF 输出 | 是 | 是 | 是 | 单帧 |
| BMP / TIFF / ICO 输出 | 是 | 是 | 是 | |
| HEIC 输出 | 是 | 是 | 平台相关 | Linux 通常不可用 |
| JXL 输出 | 是 | 是 | 否 | 仅解码 |
| SVG 输入 | 是 | 是 | 是 | 可注入 CSS |
| PDF 输入 | 否 | 是 | 否 | |
| 视频输入 | 否 | 是 | 否 | |
| `quality` / `format_quality` | 是 | 是 | 是 | |
| `autoquality` | 是 | 是 | 部分 | 基于 `max_bytes` 的质量递减 |
| `max_bytes` | 是 | 是 | 是 | |
| `jpeg_options` | 是 | 是 | 部分 | 接受参数，napi-rs 暂不暴露 progressive 等 |
| `png_options` | 是 | 是 | 部分 | 支持 quantize/colors，暂不支持 interlace |
| `webp_options` | 是 | 是 | 部分 | 接受参数，主要使用 quality |
| `avif_options` | 是 | 是 | 部分 | 支持 4:2:0 子采样 |
| `strip_metadata` / `strip_color_profile` | 是 | 是 | 接受但近似 | napi-rs 不保留 ICC |
| `preserve_hdr` | 是 | 是 | 否 | |
| `dpi` / `keep_copyright` | 是 | 是 | 接受但近似 | |

### Info 接口

| 能力 | imgproxy OSS | imgproxy Pro | SupaCloud | 说明 |
| --- | --- | --- | --- | --- |
| `size` / `format` / `dimensions` / `orientation` | 是 | 是 | 是 | |
| `exif` | 是 | 是 | 是 | |
| `colorspace` | 是 | 是 | 近似 | 固定返回 sRGB |
| `dominant_colors` | 是 | 是 | 是 | 量化近似 |
| `iptc` / `xmp` | 视版本 | 是 | 否 | |
| `video_meta` | 否 | 是 | 否 | 返回 422 |
| `detect_objects` / `classify` | 否 | 是 | 否 | 返回 422 |
| `blurhash` | 视版本 | 是 | 否 | 返回 422 |

### imgproxy Pro 专属能力

| 能力 | SupaCloud | 行为 |
| --- | --- | --- |
| ONNX 物体检测 / 分类 | 否 | `detect_objects`、`classify` 返回 422 |
| `gravity:obj` / `objw` | 近似 | 使用 saliency，不支持类别和权重 |
| `crop_objects` | 近似 | 等价于 `gravity:obj` |
| `blur_detections` | 近似 | 当前为全图模糊 |
| `draw_detections` | 否 | 返回 422 |
| 视频缩略图 | 否 | `video_thumbnail_*` 返回 422 |
| PDF 缩略图 | 否 | |
| C2PA | 否 | 参数被忽略 |
| `max_animation_frames` / `max_animation_frame_resolution` | 部分 | 解析参数，但只处理首帧，未强制限制 |

### 动画与多页

| 能力 | SupaCloud | 说明 |
| --- | --- | --- |
| GIF 解码 | 是 | 只取第一帧 |
| 动画 WebP 解码 | 部分 | 由 napi-rs 行为决定，通常取首帧 |
| GIF 编码 | 是 | 单帧 |
| `page` / `pages` | 部分 | `page > 0` 或 `pages != 1` 返回 422 |
| `disable_animation` | 是 | 接受参数，输出仍是单帧 |
| 多页 TIFF | 部分 | 由 napi-rs 行为决定 |

## 配置项

图片服务通过环境变量配置，systemd 部署写入 `/etc/supabase/image-service.env`。

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `IMGPROXY_KEY` | 空 | 十六进制 key，多组用逗号分隔；为空时不校验签名 |
| `IMGPROXY_SALT` | 空 | 十六进制 salt，数量必须与 key 一致 |
| `IMGPROXY_SIGNATURE_SIZE` | `32` | 签名字节数，1-32 |
| `IMGPROXY_TRUSTED_SIGNATURES` | 空 | 免校验签名，逗号分隔 |
| `IMGPROXY_SECRET` | 空 | Bearer 鉴权密钥 |
| `IMGPROXY_ALLOWED_SOURCES` | 空 | 源 URL 白名单，支持 `*` 通配 |
| `IMGPROXY_ALLOW_LOOPBACK_SOURCE_ADDRESSES` | `false` | 允许 127.0.0.0/8、::1 |
| `IMGPROXY_ALLOW_LINK_LOCAL_SOURCE_ADDRESSES` | `false` | 允许 169.254.0.0/16、fe80::/10 |
| `IMGPROXY_ALLOW_PRIVATE_SOURCE_ADDRESSES` | `true` | 允许私网，默认开启便于内网 MinIO |
| `IMGPROXY_LOCAL_FILESYSTEM_ROOT` | 空 | 本地源根目录，为空则禁用 |
| `IMGPROXY_SOURCE_URL_ENCRYPTION_KEY` | 空 | `enc` 源的 AES key，16/24/32 字节 |
| `IMGPROXY_BASE_URL` | 空 | 相对源 URL 的前缀 |
| `IMGPROXY_PRESETS` | 空 | 内联预设，`name=options`，逗号分隔 |
| `IMGPROXY_PRESETS_SEPARATOR` | `,` | 内联预设分隔符 |
| `IMGPROXY_PRESETS_PATH` | 空 | 预设文件路径，每行 `name=options` |
| `IMGPROXY_ONLY_PRESETS` | `false` | 只允许预设选项 |
| `IMGPROXY_QUALITY` | `80` | 默认质量 |
| `IMGPROXY_FORMAT_QUALITY` | 空 | 例如 `jpeg=75,webp=80` |
| `IMGPROXY_MAX_SRC_RESOLUTION` | `0` | 源最大百万像素，0 表示不限制 |
| `IMGPROXY_MAX_SRC_FILE_SIZE` | `0` | 源最大字节数 |
| `IMGPROXY_MAX_RESULT_DIMENSION` | `0` | 结果最大宽高 |
| `IMGPROXY_MAX_ANIMATION_FRAMES` | `0` | 解析但未强制 |
| `IMGPROXY_MAX_ANIMATION_FRAME_RESOLUTION` | `0` | 解析但未强制 |
| `IMGPROXY_AUTO_ROTATE` | `true` | 自动旋转 |
| `IMGPROXY_RETURN_ATTACHMENT` | `false` | 默认作为附件下载 |
| `IMGPROXY_ALLOW_ORIGIN` | 空 | CORS Origin |
| `IMGPROXY_TIMEOUT` | `10` | 源请求超时秒数 |
| `IMGPROXY_CACHE_CONTROL` | `public, max-age=3600, stale-while-revalidate=86400` | 缓存头 |
| `IMGPROXY_ARGUMENTS_SEPARATOR` | `:` | 选项参数分隔符 |
| `IMGPROXY_SKIP_PROCESSING_FORMATS` | 空 | 默认跳过处理的格式 |
| `IMGPROXY_STRIP_METADATA` | `true` | 接受但近似 |
| `IMGPROXY_STRIP_COLOR_PROFILE` | `true` | 接受但近似 |

## 部署与路由

图片服务默认监听 `127.0.0.1:9010`，只应通过网关或反向代理暴露。示例 Caddy 配置：

```caddyfile
img.example.com {
    reverse_proxy 127.0.0.1:9010
}
```

如果挂在子路径下，需要在反向代理层重写路径，并确保转发给服务的路径仍然是 `/:signature/:options/:source`。签名只覆盖签名之后的路径，不包含域名和查询参数。

systemd 部署时，在 `config.env` 中设置：

```bash
IMGPROXY_KEY="736563726574"
IMGPROXY_SALT="68656C6C6F"
IMGPROXY_ALLOWED_SOURCES="https://storage.example.com/*"
IMGPROXY_LOCAL_FILESYSTEM_ROOT=""
IMGPROXY_SOURCE_URL_ENCRYPTION_KEY=""
IMGPROXY_SECRET=""
```

然后重新运行安装脚本或重启服务：

```bash
systemctl restart supacloud-image
```

生产建议：

- 一定设置 `IMGPROXY_KEY` / `IMGPROXY_SALT`，不要把无签名服务直接暴露到公网。
- 用 `IMGPROXY_ALLOWED_SOURCES` 限制源站，降低 SSRF 和盗刷风险。
- 公网场景关闭 `IMGPROXY_ALLOW_PRIVATE_SOURCE_ADDRESSES`，除非源站在内网。
- 结果缓存交给 CDN，服务本身不做内部缓存。
- 对大图设置 `IMGPROXY_MAX_SRC_RESOLUTION` 和 `IMGPROXY_MAX_SRC_FILE_SIZE`。

## 迁移示例

### 从 imgproxy 迁移

1. 生成新的 key/salt，写入 `IMGPROXY_KEY` / `IMGPROXY_SALT`。
2. 将原来指向 imgproxy 的域名或路径转发到 `127.0.0.1:9010`。
3. 保持签名算法和路径格式不变，现有 imgproxy 客户端通常无需改动。
4. 用 `/info` 和签名 URL 做冒烟测试。
5. 如果使用了 S3/GCS/Azure/Swift 原生源，改成预签名 URL，或保留 imgproxy 作为源适配层。
6. 如果使用了视频、PDF、ONNX、C2PA，保留 imgproxy Pro 或增加对应适配器。

### 常用 URL

```text
# 适配 300x300，智能裁剪，输出 WebP
/<sig>/rs:fill:300:300/g:sm/plain/http://example.com/a.jpg@webp

# 固定宽 300，等比缩放，质量 85
/<sig>/w:300/q:85/plain/http://example.com/a.jpg@webp

# 缩放并加水印
/<sig>/rs:fit:800:800/wm:0.5:ce:20:20:0.2/plain/http://example.com/a.jpg@webp

# 带过期时间
/<sig>/exp:1735689600/rs:fit:300:300/plain/http://example.com/a.jpg

# 原图返回
/<sig>/raw:1/plain/http://example.com/a.jpg

# 获取 Info
/info/<sig>/plain/http://example.com/a.jpg
```

## 已知差距

以下能力当前不提供，需要保留 imgproxy Pro 或在外围补齐：

- S3、GCS、Azure Blob、Swift 原生源适配。
- 视频缩略图、PDF 缩略图、PSD。
- ONNX 物体检测、分类、`draw_detections`、真实 `blur_detections`。
- C2PA 内容凭证。
- 完整动画 GIF/WebP、多页 TIFF、动画帧数和帧分辨率限制。
- ICC 色彩管理、HDR 保留、DPI 元数据、IPTC/XMP。
- 内部结果缓存、缓存标签、Prometheus 指标。
- Pango 富文本水印。

这些差距不影响最常见的“缩放、裁剪、格式转换、质量、水印、签名、Info”工作流。若业务强依赖上述 Pro 能力，建议按路由分流：普通图片走 SupaCloud 图片服务，视频/PDF/ONNX 继续走 imgproxy Pro。
