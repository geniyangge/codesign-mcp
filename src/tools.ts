import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { CoDesignClient } from "./client.js";
import { CoDesignError } from "./errors.js";
import type {
  DownloadResult,
  LayerTree,
  ScreenDetail,
  ShareInfo,
  SliceExport,
  SliceItem,
} from "./types.js";
import { mapLimit } from "./utils/concurrency.js";
import { createNamer, sanitizeFilename } from "./utils/filename.js";

/** 需要拉取的画板数据：按工具用途惰性加载，避免额外请求 */
export interface ScreenData {
  /** 画板详情（元数据 / 预览图地址） */
  detail?: boolean;
  /** 图层树 */
  meta?: boolean;
  /** 切图清单 */
  slices?: boolean;
}

export interface ResolvedScreen {
  designId: number;
  detail: ScreenDetail;
  tree?: LayerTree;
  slices?: SliceItem[];
}

export interface ResolveOptions extends ScreenData {
  /** 并发度，默认 4 */
  concurrency?: number;
}

/**
 * 决定要处理哪些画板：显式指定 > 链接里的 > 全部。
 * 只按需拉取 meta / slices，且画板之间并发处理。
 * 密码分享的解锁在 getShare 阶段完成，画板详情接口本身不需要 state-key。
 */
export async function resolveScreens(
  client: CoDesignClient,
  share: ShareInfo,
  screenId?: number,
  options: ResolveOptions = {},
): Promise<ResolvedScreen[]> {
  const { detail = true, meta = false, slices = false, concurrency = 4 } = options;

  const all = share.designs.flatMap((d) => d.screens.map((s) => ({ designId: d.id, ...s })));
  if (!all.length) throw new CoDesignError("设计稿里没有找到任何画板");

  const targets = screenId ? all.filter((s) => s.id === screenId) : all;
  if (!targets.length) {
    throw new CoDesignError(
      `画板 ${screenId} 不存在`,
      undefined,
      "可用画板：\n" + all.map((s) => `  ${s.id}  ${s.name}`).join("\n"),
    );
  }

  return mapLimit(targets, concurrency, async (t): Promise<ResolvedScreen> => {
    // 不拿 detail 时就够不着 meta/slices，直接返回最基本信息
    if (!detail) {
      return {
        designId: t.designId,
        detail: {
          id: t.id,
          name: t.name,
          width: 0,
          height: 0,
          designId: t.designId,
          source: "",
          slicesCount: 0,
        },
      };
    }

    const detailInfo = await client.getScreen(t.designId, t.id);
    const [tree, sliceList] = await Promise.all([
      meta && detailInfo.metaUrl ? client.getMeta(detailInfo.metaUrl) : undefined,
      slices && detailInfo.slicesUrl ? client.getSlices(detailInfo.slicesUrl) : undefined,
    ]);

    return { designId: t.designId, detail: detailInfo, tree, slices: sliceList };
  });
}

/** 默认导出倍率，可用环境变量 CODESIGN_SCALE 覆盖 */
export const DEFAULT_SCALE = (() => {
  const n = Number(process.env.CODESIGN_SCALE);
  return Number.isFinite(n) && n > 0 ? n : 2;
})();

/** 每张切图最终选中的导出项，附带是否发生过倍率降级 */
export interface PickedExport {
  export: SliceExport;
  /** 该图层没有请求的倍率，实际用了别的倍率 */
  substituted: boolean;
}

/**
 * 每张切图只取一个倍率，避免同一图层下载多份。
 *
 * 倍率优先级：
 * 1. 调用方显式指定（用户在会话里说「要 3 倍图」）—— 优先满足
 * 2. 环境变量 CODESIGN_SCALE
 * 3. 内置默认 2x
 *
 * 若该图层没有正好这个倍率：就近取**不超过**目标的最高档，再退而取最低档，
 * 并把 `substituted` 标出来，由上层如实告知，不静默替换。
 */
export function pickExports(item: SliceItem, scale?: number): PickedExport[] {
  if (!item.exports.length) return [];

  const target = scale ?? DEFAULT_SCALE;
  const exactMatch = (s: number) => item.exports.filter((e) => e.scale === s);

  const exact = exactMatch(target);
  if (exact.length) return exact.map((e) => ({ export: e, substituted: false }));

  const sorted = [...new Set(item.exports.map((e) => e.scale))].sort((a, b) => a - b);
  // 优先取不超过目标的最高档（避免下载到比预期更大的文件）
  const lower = sorted.filter((s) => s < target);
  const fallback =
    lower.length > 0
      ? lower[lower.length - 1]
      : // 只有更高档时向上取最小的一档
        sorted[0];

  return exactMatch(fallback).map((e) => ({ export: e, substituted: true }));
}

export interface DownloadOptions {
  scale?: number;
  concurrency?: number;
  /** 同一目录内共享命名器，跨画板/跨批次去重 */
  namer?: ReturnType<typeof createNamer>;
}

export async function downloadSlices(
  client: CoDesignClient,
  slices: SliceItem[],
  outDir: string,
  options: DownloadOptions = {},
): Promise<DownloadResult[]> {
  await mkdir(outDir, { recursive: true });
  const namer = options.namer ?? createNamer();

  const tasks = slices.flatMap((item) =>
    pickExports(item, options.scale).map((p) => ({ item, ex: p.export, substituted: p.substituted })),
  );

  return mapLimit(tasks, options.concurrency ?? 6, async ({ item, ex, substituted }) => {
    // 文件名在下载前一次性分配，保证与 design_get_spec 里给出的名字一致且不互相覆盖
    const file = namer(sanitizeFilename(item.name, "slice"), ex.format);
    const path = join(outDir, file);
    try {
      const buf = await client.downloadImage(ex.downloadUrl);
      await writeFile(path, buf);
      return {
        name: item.name,
        path: file,
        // 实际落盘的倍率，可能与请求的倍率不同（该图层没导出这个倍率时）
        scale: ex.scale,
        substituted: substituted || undefined,
        width: ex.width,
        height: ex.height,
        bytes: buf.length,
        ok: true,
      };
    } catch (e) {
      return {
        name: item.name,
        path: file,
        scale: ex.scale,
        substituted: substituted || undefined,
        width: ex.width,
        height: ex.height,
        bytes: 0,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  });
}

export async function downloadPreviews(
  client: CoDesignClient,
  targets: ResolvedScreen[],
  outDir: string,
  options: { concurrency?: number; namer?: ReturnType<typeof createNamer> } = {},
): Promise<DownloadResult[]> {
  await mkdir(outDir, { recursive: true });
  const namer = options.namer ?? createNamer();

  return mapLimit(targets, options.concurrency ?? 6, async (t) => {
    const file = namer(`${sanitizeFilename(t.detail.name, "screen")}_preview`, "png");
    if (!t.detail.previewUrl) {
      return {
        name: t.detail.name,
        path: file,
        width: t.detail.width,
        height: t.detail.height,
        bytes: 0,
        ok: false,
        error: "该画板没有预览图",
      };
    }
    try {
      const buf = await client.downloadImage(t.detail.previewUrl);
      await writeFile(join(outDir, file), buf);
      return {
        name: t.detail.name,
        path: file,
        width: t.detail.width,
        height: t.detail.height,
        bytes: buf.length,
        ok: true,
      };
    } catch (e) {
      return {
        name: t.detail.name,
        path: file,
        width: t.detail.width,
        height: t.detail.height,
        bytes: 0,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  });
}
