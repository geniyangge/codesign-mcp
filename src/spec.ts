import type {
  Layer,
  LayerTree,
  ScreenDetail,
  SliceItem,
  SpecNode,
  SpecResult,
} from "./types.js";
import { createNamer, sanitizeFilename } from "./utils/filename.js";

const DESIGN_WIDTH = 750;
const CSS_WIDTH = 375;

/** tracking 是 Photoshop 千分之一单位，换算成 CSS letter-spacing */
function trackingToPx(tracking: number | undefined, size: number): number | undefined {
  if (tracking === undefined || tracking === null) return undefined;
  return Number(((tracking / 1000) * size).toFixed(2));
}

/**
 * 把设计稿自带的 `width:750px` 这类片段按缩放比重写。
 * 顺带修掉 CoDesign 自己输出的非法 alpha（形如 `rgba(R,G,B,100)`），
 * 那种写法浏览器会整条丢弃。
 */
function scaleCssValue(css: string, scale: number): string {
  return fixCssAlpha(css)
    .replace(/(-?\d*\.?\d+)px/g, (_m, n) => `${(Number(n) * scale).toFixed(2)}px`)
    .trim();
}

/** `rgba(r,g,b,100)` → `rgba(r,g,b,1)`；>1 的一律按百分比处理 */
function fixCssAlpha(css: string): string {
  return css.replace(
    /rgba\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)[,\s/]+([\d.]+)\s*\)/gi,
    (_m, r, g, b, a) => {
      const n = Number(a);
      const alpha = n > 1 ? Number((n / 100).toFixed(3)) : n;
      return alpha >= 1 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${alpha})`;
    },
  );
}

/**
 * 设计稿自带的 css 是最可靠的（已经处理了渐变、圆角、透明度等），
 * 有就按缩放比重写后直接用；没有才回退到手拼。
 */
function styleFromLayerCss(l: Layer, scale: number): string[] | undefined {
  if (!l.css?.length) return undefined;
  const parts = l.css.map((c) => scaleCssValue(c, scale)).filter(Boolean);
  if (!parts.length) return undefined;
  // 文本图层的 css 不带字体信息，由 styleFor 补
  if (l.type !== "text") return parts;
  return undefined;
}

function flags(l: Layer): string[] {
  const out: string[] = [];
  if (l.type === "text") out.push("text");
  return out;
}

function styleFor(l: Layer, scale: number): string[] {
  const css: string[] = [];

  if (l.type === "text" && l.text) {
    const t = l.text;
    const parts: string[] = [];
    parts.push(`font-size:${(t.size * scale).toFixed(2)}px`);
    if (t.fontName) parts.push(`font-family:"${t.fontName}",serif`);
    if (t.fontStyleName) parts.push(`font-weight:${mapFontWeight(t.fontStyleName)}`);
    if (t.color) parts.push(`color:${t.color}`);
    const ls = t.letterSpacing ?? trackingToPx(t.tracking, t.size);
    if (ls !== undefined && ls !== 0) parts.push(`letter-spacing:${(ls * scale).toFixed(2)}px`);
    const lh = t.leading ?? t.lineHeight;
    if (lh) parts.push(`line-height:${(lh * scale).toFixed(2)}px`);
    if (t.textAlign) parts.push(`text-align:${t.textAlign}`);
    css.push(parts.join("; "));
    return css;
  }

  const own = styleFromLayerCss(l, scale);
  if (own) return own;

  const { width, height } = l.rect;

  if (l.radius?.length && l.radius.some((r) => r > 0)) {
    css.push(`border-radius:${l.radius.map((r) => `${(r * scale).toFixed(2)}px`).join(" ")}`);
  }

  for (const f of l.fills ?? []) {
    if (f.type === "color" && f.color) css.push(`background:${f.color}`);
    else if (f.css) css.push(`background:${f.css}`);
  }

  for (const b of l.borders ?? []) {
    if (b.color) {
      const w = b.width !== undefined ? `${(b.width * scale).toFixed(2)}px` : "1px";
      css.push(`border:${w} ${b.style ?? "solid"} ${b.color}`);
    }
  }

  if (l.opacity !== undefined && l.opacity < 1) css.push(`opacity:${l.opacity}`);
  if (l.rotation) css.push(`transform:rotate(${l.rotation}deg)`);

  if (l.effects?.length) {
    const shadow = effectsToBoxShadow(l.effects, scale);
    if (shadow) css.push(`box-shadow:${shadow}`);
    else css.push(`/* effects: ${l.effects.length} item(s) — 需对照图层数据手写 */`);
  }

  if (l.images?.length) {
    css.push(`/* bitmap: ${l.images.length} image(s) — use slice instead */`);
  }

  if (!css.length) css.push(`width:${(width * scale).toFixed(2)}px; height:${(height * scale).toFixed(2)}px`);
  return css;
}

/** 设计稿字体粗细名称 → CSS 数值 */
function mapFontWeight(styleName: string): string {
  const s = styleName.toLowerCase();
  if (/thin|hairline/.test(s)) return "100";
  if (/extra.?light|ultra.?light/.test(s)) return "200";
  if (/light/.test(s)) return "300";
  if (/medium/.test(s)) return "500";
  if (/semi.?bold|demi.?bold/.test(s)) return "600";
  if (/extra.?bold|ultra.?bold/.test(s)) return "800";
  if (/black|heavy/.test(s)) return "900";
  if (/bold/.test(s)) return "700";
  return "400";
}

/**
 * 把 innerGlow / frameFX / dropShadow 之类的 Photoshop 效果
 * 映射成一条或多条 CSS box-shadow。返回 undefined 表示无法可靠映射。
 */
function effectsToBoxShadow(effects: NonNullable<Layer["effects"]>, scale: number): string | undefined {
  const parts: string[] = [];

  for (const fx of effects) {
    const color = colorOf(fx.color, fx.opacity);
    const blur = num(fx.blur) ?? num(fx.size);
    const offsetX = num(fx.distance) ?? 0;
    const offsetY = num(fx.distance) ?? 0;

    if (fx.type === "innerGlow") {
      const inset = "inset";
      const b = (blur ?? 0) * scale;
      parts.push(`${inset} 0 0 ${b.toFixed(2)}px ${color ?? "currentColor"}`);
    } else if (fx.type === "frameFX") {
      // 描边效果：用 inset 0 0 0 Npx 实现
      const size = (num(fx.size) ?? 0) * scale;
      parts.push(`inset 0 0 0 ${size.toFixed(2)}px ${color ?? "currentColor"}`);
    } else if (fx.type === "dropShadow") {
      const b = (blur ?? 0) * scale;
      parts.push(
        `${(offsetX * scale).toFixed(2)}px ${(offsetY * scale).toFixed(2)}px ${b.toFixed(2)}px ${color ?? "currentColor"}`,
      );
    }
  }

  return parts.length ? parts.join(", ") : undefined;
}

function colorOf(color: any, opacity: any): string | undefined {
  if (!color) return undefined;
  const r = Math.round(color.red ?? color.r ?? 0);
  const g = Math.round(color.green ?? color.g ?? 0);
  const b = Math.round(color.blue ?? color.b ?? 0);
  const alphaRaw = typeof opacity === "object" ? opacity?.value : opacity;
  const alpha = typeof alphaRaw === "number" ? (alphaRaw > 1 ? alphaRaw / 100 : alphaRaw) : 1;
  return alpha >= 1 ? `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}` : `rgba(${r},${g},${b},${alpha.toFixed(2)})`;
}

function num(v: any): number | undefined {
  const n = typeof v === "object" ? v?.value : v;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

function flatten(layers: Layer[], depth = 0, out: { layer: Layer; depth: number }[] = []) {
  for (const l of layers) {
    out.push({ layer: l, depth });
    if (l.children?.length) flatten(l.children, depth + 1, out);
  }
  return out;
}

export interface SpecOptions {
  cssWidth?: number;
  /** 最多输出多少图层，超出截断并在 notes 里说明 */
  maxLayers?: number;
  /** 最多下钻几层 */
  maxDepth?: number;
  /** 切图命名器：传入下载时用过的同一个，保证文件名一致 */
  namer?: ReturnType<typeof createNamer>;
}

/**
 * 把图层树 + 切图清单整理成前端可直接使用的规格。
 * 默认按 750 设计稿 → 375 CSS 宽输出（scale = 0.5）。
 */
export function buildSpec(
  screen: ScreenDetail,
  tree: LayerTree,
  slices: SliceItem[],
  options: SpecOptions | number = {},
): SpecResult {
  const opts: SpecOptions = typeof options === "number" ? { cssWidth: options } : options;
  const cssWidth = opts.cssWidth ?? CSS_WIDTH;
  const maxLayers = opts.maxLayers ?? 500;
  const maxDepth = opts.maxDepth ?? Infinity;
  const namer = opts.namer ?? createNamer();

  const scale = cssWidth / (tree.width || DESIGN_WIDTH);
  const flat = flatten(tree.layers);
  const visible = flat.filter(({ layer }) => layer.visible);
  const withinDepth = visible.filter(({ depth }) => depth <= maxDepth);
  const kept = withinDepth.slice(0, maxLayers);
  const truncated =
    withinDepth.length > kept.length
      ? { total: withinDepth.length, returned: kept.length }
      : undefined;

  const nodes: SpecNode[] = kept.map(({ layer, depth }) => ({
    name: `${"  ".repeat(depth)}${layer.name || layer.type}`,
    type: layer.type,
    objectId: layer.objectId,
    box: {
      left: Number((layer.rect.x * scale).toFixed(2)),
      top: Number((layer.rect.y * scale).toFixed(2)),
      width: Number((layer.rect.width * scale).toFixed(2)),
      height: Number((layer.rect.height * scale).toFixed(2)),
    },
    style: [...flags(layer), ...styleFor(layer, scale)],
    text: layer.text?.content,
  }));

  // 切图按 objectId 关联图层，能带上图层自身的盒子和样式（组图层没有 css）
  const byObjectId = new Map(flat.map(({ layer }) => [layer.objectId, layer]));
  const sliceSpec = slices.flatMap((s) =>
    s.exports.map((ex) => {
      // 用与下载一致的命名器分配文件名，避免 design_download_slices 落盘名字对不上
      const layer = byObjectId.get(String(s.id)) ?? byObjectId.get(String(ex.objectId));
      return {
        name: s.name,
        objectId: s.id,
        left: Number((s.rect.x * scale).toFixed(2)),
        top: Number((s.rect.y * scale).toFixed(2)),
        width: Number((s.rect.width * scale).toFixed(2)),
        height: Number((s.rect.height * scale).toFixed(2)),
        scale: ex.scale,
        file: namer(sanitizeFilename(s.name, "slice"), ex.format),
        ...(layer?.css?.length ? { style: layer.css.map((c) => scaleCssValue(c, scale)) } : {}),
      };
    }),
  );

  const maxDepthReached = flat.reduce((m, x) => Math.max(m, x.depth), 0);
  const notes: string[] = [
    `设计稿尺寸 ${tree.width}×${tree.height}，按 ${cssWidth} 宽输出，缩放比 ${scale}`,
    "box 与 style 中所有数值均已按缩放比换算，可直接写进 CSS",
    "图层坐标为相对画板左上角的绝对定位值",
    `图层共 ${flat.length} 个，最大嵌套深度 ${maxDepthReached}`,
  ];

  if (truncated) {
    notes.push(
      `图层过多，仅输出前 ${truncated.returned} 个（共 ${truncated.total} 个）。` +
        "可传 maxLayers/maxDepth 调整，或指定 screenId 缩小范围",
    );
  }

  const hasBitmapText = nodes.some((n) => n.type === "text" && !n.text);
  if (hasBitmapText) {
    notes.push("部分文本图层缺少文字内容，可能需要 OCR 或人工确认");
  }
  if (sliceSpec.length) {
    notes.push(`共 ${sliceSpec.length} 个切图，可用 design_download_slices 下载`);
  }
  const fonts = new Set(
    flat.filter(({ layer }) => layer.text?.fontName).map(({ layer }) => layer.text!.fontName),
  );
  if (fonts.size) {
    notes.push(`使用的字体：${[...fonts].join(", ")}，注意设备端可能缺失需要 web font`);
  }
  const slicedIds = new Set(slices.map((s) => String(s.id)));
  const groupsWithoutCss = flat.filter(
    ({ layer }) => layer.type === "group" && !layer.css?.length && !slicedIds.has(layer.objectId),
  );
  if (groupsWithoutCss.length) {
    notes.push(
      `${groupsWithoutCss.length} 个组图层既没有 css 也没有切图，其视觉效果来自子图层或未导出的合成，需要人工确认`,
    );
  }

  return {
    screen: screen.name,
    size: { width: tree.width, height: tree.height },
    cssWidth,
    scale,
    nodes,
    slices: sliceSpec,
    notes,
    ...(truncated ? { truncated } : {}),
  };
}
