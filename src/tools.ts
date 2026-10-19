import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { CoDesignClient } from "./client.js";
import { CoDesignError } from "./errors.js";
import type {
  DownloadResult,
  LayerTree,
  ScreenDetail,
  ShareInfo,
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

/** 每张切图只取目标倍率（默认最高），避免重复下载 */
export function pickExports(item: SliceItem, scale?: number) {
  if (!item.exports.length) return [];
  if (scale !== undefined) {
    const exact = item.exports.filter((e) => e.scale === scale);
    if (exact.length) return exact;
  }
  const max = Math.max(...item.exports.map((e) => e.scale));
  return item.exports.filter((e) => e.scale === max);
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
    pickExports(item, options.scale).map((ex) => ({ item, ex })),
  );

  return mapLimit(tasks, options.concurrency ?? 6, async ({ item, ex }) => {
    // 文件名在下载前一次性分配，保证与 design_get_spec 里给出的名字一致且不互相覆盖
    const file = namer(sanitizeFilename(item.name, "slice"), ex.format);
    const path = join(outDir, file);
    try {
      const buf = await client.downloadImage(ex.downloadUrl);
      await writeFile(path, buf);
      return {
        name: item.name,
        path: file,
        width: ex.width,
        height: ex.height,
        bytes: buf.length,
        ok: true,
      };
    } catch (e) {
      return {
        name: item.name,
        path: file,
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
