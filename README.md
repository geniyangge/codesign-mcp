# codesign-mcp

腾讯 CoDesign 设计稿 MCP 服务。让 AI 直接读取设计稿的图层标注、下载切图、生成还原规格。

```
帮我读取并还原设计稿 https://codesign.qq.com/app/s/<分享ID>
```

## 能做什么

| 工具 | 作用 |
|---|---|
| `design_get` | 读取设计稿：画板列表 + 完整图层树（坐标、尺寸、字体、字号、字距、颜色、圆角、渐变、效果） |
| `design_download_slices` | 批量下载切图，自动处理 OSS 签名地址 |
| `design_download_previews` | 下载画板整图，供 AI 视觉理解 |
| `design_get_spec` | 转成前端可直接用的 CSS 规格（默认 750 → 375 换算） |

所有工具的参数都由 zod 校验，传错类型会直接返回明确的参数错误，不会带着脏数据往下跑。

## 安装

### 方式一：npx（推荐）

在项目根目录的 `.mcp.json`：

```json
{
  "mcpServers": {
    "codesign-mcp": {
      "command": "npx",
      "args": ["-y", "codesign-mcp"],
      "env": {
        "CODESIGN_COOKIE": "你的 Cookie"
      }
    }
  }
}
```

### 方式二：本地构建

```bash
git clone https://github.com/geniyangge/codesign-mcp.git
cd codesign-mcp
npm install
npm run build
```

构建后把 `dist/index.js` 的**绝对路径**填到 `args` 里：

```json
{
  "mcpServers": {
    "codesign-mcp": {
      "command": "node",
      "args": ["/path/to/codesign-mcp/dist/index.js"],
      "env": {
        "CODESIGN_COOKIE": "你的 Cookie"
      }
    }
  }
}
```

> Windows 下路径写成 `"D:\\\\path\\\\to\\\\codesign-mcp\\\\dist\\\\index.js"` 或 `"D:/path/to/codesign-mcp/dist/index.js"`。

## 获取 Cookie

图层标注和切图需要登录态，**必须先配置 Cookie**。

1. 浏览器登录 https://codesign.qq.com
2. 打开目标设计稿的分享页
3. `F12` → **Network** 面板
4. 刷新页面，任选一条 `/api/` 开头的请求
5. 右键 → **Copy** → **Copy as cURL (bash)**
6. 找到 `-b '...'` 引号里的内容，整段复制

或者 `F12` → Console 输入 `document.cookie`，但部分 token 是 httpOnly，用上面 Copy as cURL 的方式更完整。

把这段内容填到 `CODESIGN_COOKIE`。`access_token` 通常 30 天有效，过期后重新复制即可。

> 不想把 Cookie 写进仓库？用环境变量：
> ```json
> "env": { "CODESIGN_COOKIE": "${CODESIGN_COOKIE}" }
> ```
> 然后在 shell 配置文件里 `export CODESIGN_COOKIE="..."`
>
> 旧版本用的 `CODEDESIGN_COOKIE` 已废弃，请改用 `CODESIGN_COOKIE`。

## 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `CODESIGN_COOKIE` | 读标注/切图必填 | CoDesign 登录 Cookie |
| `CODESIGN_PASSWORD` | 否 | 默认分享访问密码，工具未传 `password` 时兜底 |
| `CODESIGN_SCALE` | 否 | 默认切图倍率，默认 `2`；工具传了 `scale` 时以工具参数为准 |
| `CODESIGN_OUT_DIR` | 否 | 默认输出目录，默认 `./codesign-assets` |
| `CODESIGN_CONCURRENCY` | 否 | 并发请求数，默认 4，范围 1–16；被限流（429）时调小 |
| `CODESIGN_TIMEOUT_MS` | 否 | 单次请求超时，默认 30000，范围 1000–120000 |

> 不再读取通用的 `COOKIE` 环境变量，避免误用 shell 里无关的 Cookie。

## 使用

配好后直接在 Claude Code 里说：

```
帮我读取并还原设计稿 https://codesign.qq.com/app/s/<分享ID>
```

AI 会自动按这个顺序工作：

1. `design_download_previews` — 先看整体视觉
2. `design_get` — 拿精确图层标注
3. `design_download_slices` — 下载切图
4. `design_get_spec` — 生成 CSS 规格
5. 写代码

也可以指定画板：

```
读取这个设计稿的弹窗画板（ID: <画板ID>）
```

> 分享 ID 和画板 ID 都在设计稿链接里：`/app/s/<分享ID>/<画板ID>`。

## 带密码的设计稿

分享时勾选了「密码保护」的设计稿，直接读取会返回 403「请输入密码」，此时把密码作为 `password` 参数传入即可：

```
帮我读取并还原设计稿 https://codesign.qq.com/s/<分享ID>/<画板ID>/inspect，密码 ABCD
```

工具会自动：

1. `POST /api/sharings/<id>/state-keys` 用密码换一个 `state-key`
2. 后续分享详情请求带上 `state-key` 头（同一密码会缓存，不用反复换）
3. 画板详情、图层和切图接口沿用原有 Cookie 鉴权，不需要 `state-key`

也可以设一次环境变量，之后都不用传：

```json
"env": { "CODESIGN_PASSWORD": "ABCD" }
```

**密码解不开权限**：密码只解锁「分享内容」这一层。如果当前 `CODESIGN_COOKIE` 的账号不在设计稿所属项目里，密码正确仍会返回「您当前暂无权限」。这种情况需要换用有权限的账号，或让设计同学把账号加入项目。

## 工具参数

### design_get

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `url` | string | ✅ | 分享链接 |
| `password` | string | | 分享访问密码，密码保护的分享必填 |
| `screenId` | number | | 只解析指定画板 |
| `includeLayers` | boolean | | 是否返回图层树，默认 true |
| `maxLayers` | number | | 每个画板最多返回的图层数，默认 800 |
| `maxDepth` | number | | 最多下钻层数，默认不限 |

图层数超过 `maxLayers` 时结果里会出现 `truncated` 和 `warning`，不会静默截断。

### design_download_slices

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `url` | string | ✅ | 分享链接 |
| `password` | string | | 分享访问密码，密码保护的分享必填 |
| `screenId` | number | | 画板 ID |
| `outDir` | string | | 输出目录 |
| `scale` | number | | 导出倍率，默认 2 |

**倍率优先级**：用户在对话里明确要求 > 环境变量 `CODESIGN_SCALE` > 内置默认 2x。

某图层若没有目标倍率的导出，会就近取（优先取不高于目标的最高档），并在返回的 `warning` 里逐条列出，不会静默替换。返回值里的 `scaleUsage` 汇总了实际用到的倍率，`requestedScale` 是本次请求的倍率。

```json
{
  "requestedScale": 2,
  "scaleUsage": { "3": 44, "2.84": 2 },
  "warning": "以下 46 张切图在设计稿里没有 2 倍导出，已就近取其他倍率：..."
}
```

同名图层自动追加 `_2`、`_3`，不会互相覆盖。返回的 `path` 是相对 `outDir` 的文件名，和 `design_get_spec` 里的 `file` 字段一致。

导出格式同时有 `png` 和 `svg` 时都会下载。注意 `imageMogr2` 是腾讯云图片处理参数，只能处理位图，代码对 svg 会自动跳过（否则会返回 400 `InvalidImageFormat`）。

### design_download_previews

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `url` | string | ✅ | 分享链接 |
| `password` | string | | 分享访问密码，密码保护的分享必填 |
| `screenId` | number | | 画板 ID |
| `outDir` | string | | 输出目录 |

只拉画板详情，不会额外请求图层树和切图清单。

### design_get_spec

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `url` | string | ✅ | 分享链接 |
| `password` | string | | 分享访问密码，密码保护的分享必填 |
| `screenId` | number | | 画板 ID |
| `cssWidth` | number | | 目标 CSS 宽度，默认 375；传 750 输出原始 px |
| `maxLayers` | number | | 最多输出多少图层，默认 500 |
| `maxDepth` | number | | 最多下钻层数，默认不限 |

输出里的 `nodes` 按图层树嵌套顺序排列，`name` 前的空格表示层级，`objectId` 可与切图清单关联。
`slices[].style` 会带上该图层自带的 CSS（组图层没有，需要看子图层）。

## 技术说明

CoDesign 没有开放 API，本项目通过逆向其内部接口实现：

| 接口 | 鉴权 |
|---|---|
| `/api/sharings/<shareId>` | 无需登录；密码分享需 `state-key` 头 |
| `/api/sharings/<shareId>/state-keys` | `POST {password}` → `{key, expires}` |
| `/api/designs/<designId>/screens/<screenId>` | Cookie + `Authorization: Bearer` |
| `cdn4.codesign.qq.com/meta/...`（图层/切图 JSON） | 需 `Origin: https://codesign.qq.com` |
| 切图图片 | 同上，位图需带 `?imageMogr2/format/png`，svg 不能带 |

几个坑已在代码里处理（均经真实设计稿实测）：

- 切图清单给的是 OSS 签名直链，直接下会 `AccessDenied` → 自动换 CDN 域名并追加 `imageMogr2` 参数（保留原有签名参数顺序，不重排）
- CDN 资源只带 Referer 会 403，必须有 Origin
- 鉴权接口只带 Cookie 会返回「非项目成员」，必须显式带 Bearer token
- **meta 里的 `layers` 与 `groups` 是两个扁平数组**，真实层级只存在于 `parent_id` 上，代码会重建整棵树（否则拿到的是没有父子关系的散图层，`maxDepth` 也会失效）
- `rect` 已经是相对画板的绝对坐标，不需要逐层累加
- 文本字号要取 `impliedFontSize`，`textStyle.size` 是会被缩放的排版原始值（两者可能相差 15% 以上）
- `textKey` 才是正文内容
- `fontCaps: "allCaps"` 在线上数据里普遍出现在越南语等普通文本上，**不是真的大写**，因此不输出 `text-transform`
- 颜色 alpha 单位不固定：普通填充是 0–1，半透明遮罩会返回 `a:100`、`color-hex: "#000000 10000%"`，`css-rgba` 也是非法的 `rgba(0,0,0,100)`。代码会统一归一化
- CoDesign 自带的 `css` 字段里也有非法 alpha（形如 `rgba(R,G,B,100)`），浏览器会整条丢弃，代码会修正后再用
- 组图层本身通常没有 `css`，视觉效果要么来自子图层，要么由切图提供；两种情况代码都在 notes 里提示
- 密码保护的分享：**带 Cookie 访问时返回的是「您当前暂无权限」而不是「请输入密码」**，无法从一次请求判断是否缺密码；代码会用一个不含 Cookie 的探测请求确认后再提示补密码
- 密码错误返回 `403「密码错误！」`（不是 422）；`422` 只用于密码长度等格式校验
- 接口返回的 JSON 会把中文转义成 `\uXXXX`，错误判断必须先解开 `message` 字段，否则永远匹配不到「请输入密码」
- `imageMogr2` 只能处理位图，对 svg 会返回 `400 InvalidImageFormat`，代码按导出格式自动跳过
- `fontStyleName` 既可能是 `"Bold"` 也可能是数字 `700`，两者都要能转成 CSS `font-weight`

实现上有几点值得一提：

- **按需加载**：`design_download_previews` 不会去拉图层树，`design_get` 不传 `includeLayers` 也不拉
- **并发**：画板解析与切图下载都走固定并发池（`mapLimit`），不会一个画板一个画板地串行等
- **超时与重试**：每个请求带超时；`5xx` / `429` 自动退避重试，`4xx` 直接失败不白等
- **文件名**：统一走 `sanitizeFilename`，处理 Windows 非法字符、保留名（CON/NUL…）和尾部点空格，同名自动加序号
- **样式优先级**：图层自带的 `css` > 代码从 fills/radius/borders/effects 拼接

## 开发

```bash
npm run dev           # tsc --watch
npm test              # 校验版本号 + 编译测试 + node:test 跑单测
npm run build         # 产出 dist/
npm run version:check # 校验版本号是否一致
npm run version:sync  # 把 src/version.ts 的版本号同步到 package.json
```

测试覆盖纯函数（链接解析、CDN 地址改写、文件名、并发池、规格生成）以及 client 的鉴权头、错误翻译与重试行为。

### 发布新版本

版本号只维护 **`src/version.ts`** 一处，`package.json` 是它的副本：

```bash
# 1. 改 src/version.ts 里的 VERSION
# 2. 同步到 package.json
npm run version:sync

# 3. 同步到 package-lock.json
npm install --package-lock-only

# 4. 验证并提交打 tag
npm run version:check
git commit -am "chore: release v1.0.1"
git tag -a 1.0.1 -m "v1.0.1"
git push && git push origin 1.0.1
```

`npm test` 和 `prepublishOnly` 都会执行 `version:check`，两处版本号不一致时直接失败，避免漏同步。

## 常见问题

**返回「非项目成员」**

账号不在设计稿所属团队。让设计同学把账号加进项目，或者请对方开启分享页的「可查看标注」权限。

**切图下载失败**

检查分享设置里 `assetsDownloadable` 是否为 true。为 false 时设计稿禁止下载切图，需要设计同学开启。

**图层是空的**

`includeLayers` 为 false，或者该画板没有上传源文件（只有预览图）。

**结果被截断**

图层太多时按 `maxLayers`（默认 800）截断，结果里会带 `truncated` 和 `warning`。指定 `screenId` 逐个读，或调大 `maxLayers`。

**接口随时可能失效**

这是对未公开接口的逆向实现，腾讯改接口或加风控都可能让它失效。遇到异常请先确认网页端是否正常。

## License

MIT
