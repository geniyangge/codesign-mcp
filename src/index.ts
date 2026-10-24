#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { CoDesignClient, parseScreenId, parseShareId } from "./client.js";
import { isCoDesignError } from "./errors.js";
import { buildSpec } from "./spec.js";
import { DEFAULT_SCALE, downloadSlices, downloadPreviews, resolveScreens } from "./tools.js";
import type { Layer } from "./types.js";
import { createNamer } from "./utils/filename.js";
import { VERSION } from "./version.js";

const COOKIE = process.env.CODESIGN_COOKIE || "";
const DEFAULT_OUT = process.env.CODESIGN_OUT_DIR || "./codesign-assets";
const DEFAULT_PASSWORD = process.env.CODESIGN_PASSWORD || undefined;
const CONCURRENCY = clampInt(process.env.CODESIGN_CONCURRENCY, 4, 1, 16);
const TIMEOUT_MS = clampInt(process.env.CODESIGN_TIMEOUT_MS, 30_000, 1_000, 120_000);
// 默认倍数由 client 侧统一处理，这里只用于文档提示

const client = new CoDesignClient(COOKIE, { timeoutMs: TIMEOUT_MS, defaultPassword: DEFAULT_PASSWORD });

const server = new McpServer({ name: "codesign-mcp", version: VERSION });

const urlSchema = z
  .string()
  .min(1)
  .describe("CoDesign 分享链接，如 https://codesign.qq.com/app/s/<分享ID>");
const passwordSchema = z
  .string()
  .min(1)
  .optional()
  .describe(
    "分享访问密码。若设计稿开启了密码保护，接口会返回 403「请输入密码」，此时必须提供。" +
      `不传则使用环境变量 CODESIGN_PASSWORD${DEFAULT_PASSWORD ? "（当前已配置）" : "（当前未配置）"}。`,
  );
const screenIdSchema = z
  .number()
  .int()
  .positive()
  .optional()
  .describe("画板 ID；不传则用链接中的画板，链接也没有则处理全部画板");
const outDirSchema = z
  .string()
  .min(1)
  .optional()
  .describe(`输出目录，默认 ${DEFAULT_OUT}`);

server.registerTool(
  "design_get",
  {
    title: "读取设计稿图层标注",
    description: [
      "读取腾讯 CoDesign 设计稿：返回设计稿标题、团队、所有画板列表，",
      "以及每个画板的完整图层标注（坐标、尺寸、字体、字号、字距、颜色、圆角、渐变、效果）。",
      "传入分享链接即可。若链接里带画板 ID 则只解析该画板，否则解析全部。",
      "这是还原设计稿的第一步，先用它拿到图层结构。",
    ].join(""),
    inputSchema: {
      url: urlSchema,
      password: passwordSchema,
      screenId: screenIdSchema,
      includeLayers: z.boolean().optional().describe("是否返回图层标注树，默认 true"),
      maxLayers: z
        .number()
        .int()
        .positive()
        .max(20000)
        .optional()
        .describe("每个画板最多返回多少图层，默认 800；超出会截断并标注 truncated"),
      maxDepth: z
        .number()
        .int()
        .min(0)
        .max(50)
        .optional()
        .describe("最多下钻几层图层，默认不限"),
    },
  },
  async (args) => run(() => handleDesignGet(args)),
);

server.registerTool(
  "design_download_slices",
  {
    title: "下载切图",
    description: [
      "批量下载 CoDesign 画板的切图。",
      "自动把 OSS 签名地址转换为可下载的 CDN 地址，按图层名命名文件，同名自动加序号。",
      `默认导出 ${DEFAULT_SCALE} 倍图。`,
      "重要：如果用户在对话里明确说了要几倍图（例如「要 3 倍图」「导出 @2x」），",
      "必须把倍数传给 scale 参数，用户指定的优先级高于默认值。",
      "某图层若没有该倍率的导出，会就近取其他倍率并在 warning 里列出，不会静默替换。",
      "返回每个文件的相对路径、像素尺寸、字节数和实际倍率。",
    ].join(""),
    inputSchema: {
      url: urlSchema,
      password: passwordSchema,
      screenId: screenIdSchema,
      outDir: outDirSchema,
      scale: z
        .number()
        .positive()
        .optional()
        .describe(
          `导出倍率，默认 ${DEFAULT_SCALE}。` +
            "用户明确要求几倍图时务必传这个参数（如用户说「3 倍图」就传 3）。" +
            "该图层没有指定倍率时会就近取并在 warning 中说明。",
        ),
    },
  },
  async (args) => run(() => handleDownloadSlices(args)),
);

server.registerTool(
  "design_download_previews",
  {
    title: "下载画板预览图",
    description: [
      "下载画板的整图预览（PNG），供 AI 直接读图理解视觉设计。",
      "还原设计稿前建议先调这个，用视觉判断整体布局，再用 design_get 拿精确数值。",
    ].join(""),
    inputSchema: {
      url: urlSchema,
      password: passwordSchema,
      screenId: screenIdSchema,
      outDir: outDirSchema,
    },
  },
  async (args) => run(() => handleDownloadPreviews(args)),
);

server.registerTool(
  "design_get_spec",
  {
    title: "生成 CSS 还原规格",
    description: [
      "把设计稿图层树转换成前端可直接使用的还原规格：",
      "每个元素的 CSS 盒子（已换算成目标宽度）、font-size/color/letter-spacing/border-radius 等样式、",
      "字体清单、切图位置表。默认按 750 设计稿转 375 CSS 宽。",
    ].join(""),
    inputSchema: {
      url: urlSchema,
      password: passwordSchema,
      screenId: screenIdSchema,
      cssWidth: z
        .number()
        .positive()
        .max(4096)
        .optional()
        .describe("目标 CSS 宽度，默认 375；传 750 则输出设计稿原始 px"),
      maxLayers: z
        .number()
        .int()
        .positive()
        .max(20000)
        .optional()
        .describe("最多输出多少图层，默认 500；超出会截断并在 notes 里说明"),
      maxDepth: z
        .number()
        .int()
        .min(0)
        .max(50)
        .optional()
        .describe("最多下钻几层图层，默认不限"),
    },
  },
  async (args) => run(() => handleGetSpec(args)),
);

/** 统一的执行包装：错误翻译成给 AI 看的提示 */
async function run(handler: () => Promise<ReturnType<typeof jsonResult>>) {
  try {
    return await handler();
  } catch (e) {
    return errorResult(formatError(e));
  }
}

async function handleDesignGet(args: {
  url: string;
  password?: string;
  screenId?: number;
  includeLayers?: boolean;
  maxLayers?: number;
  maxDepth?: number;
}) {
  const share = await client.getShare(parseShareId(args.url), args.password || undefined);
  const includeLayers = args.includeLayers !== false;
  const targets = await resolveScreens(
    client,
    share,
    args.screenId ?? parseScreenId(args.url),
    { meta: includeLayers, concurrency: CONCURRENCY },
  );

  const maxLayers = args.maxLayers ?? 800;
  const maxDepth = args.maxDepth ?? Infinity;

  const payload: any = {
    share: {
      id: share.id,
      title: share.title,
      team: share.teamName,
      permissions: share.permissions,
    },
    screens: [] as any[],
  };

  for (const t of targets) {
    const entry: any = {
      id: t.detail.id,
      name: t.detail.name,
      size: `${t.detail.width}×${t.detail.height}`,
      preview: t.detail.previewUrl,
      sliceCount: t.detail.slicesCount,
    };

    if (includeLayers && t.tree) {
      const total = countLayers(t.tree.layers);
      const limited = limitTree(t.tree.layers, maxLayers, maxDepth);
      entry.layers = limited.layers;
      entry.layerCount = total;
      if (limited.truncated) {
        entry.truncated = { returned: limited.returned, maxLayers, maxDepth: maxDepth === Infinity ? undefined : maxDepth };
        payload.warning =
          `图层总数 ${total} 超过上限 ${maxLayers}，已截断。` +
          "如需完整数据，可指定 screenId 逐个读取，或调大 maxLayers。";
      }
    }
    payload.screens.push(entry);
  }

  if (!client.hasCookie) {
    payload.warning =
      "未配置 COOKIE，只返回了基础信息。要读取图层标注和切图，请设置环境变量 CODESIGN_COOKIE。";
  }

  return jsonResult(payload);
}

async function handleDownloadSlices(args: {
  url: string;
  password?: string;
  screenId?: number;
  outDir?: string;
  scale?: number;
}) {
  const share = await client.getShare(parseShareId(args.url), args.password || undefined);
  const targets = await resolveScreens(client, share, args.screenId ?? parseScreenId(args.url), {
    slices: true,
    concurrency: CONCURRENCY,
  });

  const outDir = args.outDir || DEFAULT_OUT;
  const results: any[] = [];

  for (const t of targets) {
    // 多画板时每个画板一个子目录，目录内各自去重
    const dir = targets.length > 1 ? `${outDir}/${sanitize(t.detail.name)}` : outDir;
    const downloaded = await downloadSlices(client, t.slices ?? [], dir, {
      scale: args.scale,
      concurrency: CONCURRENCY * 2,
    });
    results.push({ screen: t.detail.name, dir, files: downloaded });
  }

  const total = results.reduce((n, r) => n + r.files.filter((f: any) => f.ok).length, 0);
  const failed = results.reduce((n, r) => n + r.files.filter((f: any) => !f.ok).length, 0);

  // 汇总实际用到的倍率：某个图层没有请求倍率时会被就近替换，这里如实反馈
  const requestedScale = args.scale ?? DEFAULT_SCALE;
  const scaleUsage: Record<string, number> = {};
  const substituted: { name: string; scale: number }[] = [];
  for (const r of results) {
    for (const f of r.files) {
      if (!f.ok || f.scale === undefined) continue;
      scaleUsage[String(f.scale)] = (scaleUsage[String(f.scale)] ?? 0) + 1;
      if (f.substituted) substituted.push({ name: f.name, scale: f.scale });
    }
  }

  const payload: any = { outDir, requestedScale, total, failed, scaleUsage, screens: results };
  if (substituted.length) {
    payload.warning =
      `以下 ${substituted.length} 张切图在设计稿里没有 ${requestedScale} 倍导出，已就近取其他倍率：\n` +
      substituted.map((s) => `  ${s.name} → ${s.scale}x`).join("\n") +
      "\n如需严格匹配，请确认设计稿里该图层导出的倍率。";
  }

  return jsonResult(payload);
}

async function handleDownloadPreviews(args: {
  url: string;
  password?: string;
  screenId?: number;
  outDir?: string;
}) {
  const share = await client.getShare(parseShareId(args.url), args.password || undefined);
  // 预览只需要画板详情，不必拉图层树和切图清单
  const targets = await resolveScreens(client, share, args.screenId ?? parseScreenId(args.url), {
    concurrency: CONCURRENCY,
  });

  const outDir = args.outDir || DEFAULT_OUT;
  const files = await downloadPreviews(client, targets, outDir, {
    concurrency: CONCURRENCY,
  });
  const failed = files.filter((f) => !f.ok).length;
  return jsonResult({ outDir, total: files.length - failed, failed, files });
}

async function handleGetSpec(args: {
  url: string;
  password?: string;
  screenId?: number;
  cssWidth?: number;
  maxLayers?: number;
  maxDepth?: number;
}) {
  const share = await client.getShare(parseShareId(args.url), args.password || undefined);
  const explicit = args.screenId ?? parseScreenId(args.url);
  const targets = await resolveScreens(client, share, explicit, {
    meta: true,
    slices: true,
    concurrency: CONCURRENCY,
  });
  // 未指定画板时只输出第一个，避免多画板时结果过长
  const picked = explicit ? targets : targets.slice(0, 1);

  // 规格与下载共用同一套命名规则，保证 file 字段和实际落盘一致
  const namer = createNamer();
  const specs = picked.map((t) =>
    buildSpec(t.detail, t.tree!, t.slices ?? [], {
      cssWidth: args.cssWidth,
      maxLayers: args.maxLayers,
      maxDepth: args.maxDepth,
      namer,
    }),
  );
  return jsonResult({
    title: share.title,
    count: specs.length,
    totalScreens: targets.length,
    ...(explicit ? {} : { screenIds: targets.map((t) => ({ id: t.detail.id, name: t.detail.name })) }),
    specs,
  });
}

function countLayers(layers: Layer[]): number {
  return layers.reduce((n, l) => n + 1 + (l.children?.length ? countLayers(l.children) : 0), 0);
}

/**
 * 按数量上限和深度上限裁剪图层树。
 * 返回的是正常图层对象（子树按需截断），不是扁平的，方便 AI 直接读结构。
 */
function limitTree(
  layers: Layer[],
  maxLayers: number,
  maxDepth: number,
  depth = 0,
  state = { count: 0, truncated: false },
): { layers: Layer[]; truncated: boolean; returned: number } {
  const out: Layer[] = [];
  for (const l of layers) {
    if (state.count >= maxLayers) {
      state.truncated = true;
      break;
    }
    state.count++;
    if (depth < maxDepth && l.children?.length) {
      const childLimit = limitTree(l.children, maxLayers, maxDepth, depth + 1, state);
      const { children, ...rest } = l;
      out.push({ ...rest, children: childLimit.layers });
    } else {
      if (l.children?.length) state.truncated = true;
      const { children, ...rest } = l;
      out.push(rest);
    }
  }
  return { layers: out, truncated: state.truncated, returned: state.count };
}

function sanitize(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "_").trim() || "screen";
}

function formatError(e: unknown): string {
  if (isCoDesignError(e)) {
    const lines = [`❌ ${e.message}`];
    if (e.hint) lines.push("", e.hint);
    return lines.join("\n");
  }
  return `❌ ${e instanceof Error ? e.message : String(e)}`;
}

function jsonResult(obj: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }] };
}

function errorResult(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true as const };
}

function clampInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

const transport = new StdioServerTransport();
await server.connect(transport);
