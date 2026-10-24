export interface ScreenRef {
  id: number;
  name: string;
}

export interface DesignRef {
  id: number;
  name: string;
  viewport: string;
  screens: ScreenRef[];
}

export interface ShareInfo {
  id: number;
  title: string;
  teamName: string;
  permissions: {
    commentable: boolean;
    inspectable: boolean;
    assetsDownloadable: boolean;
  };
  designs: DesignRef[];
}

export interface ScreenDetail {
  id: number;
  name: string;
  width: number;
  height: number;
  designId: number;
  source: string;
  metaUrl?: string;
  slicesUrl?: string;
  previewUrl?: string;
  slicesCount: number;
}

export interface LayerRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TextStyle {
  fontName: string;
  fontStyleName: string;
  /** 渲染后的实际字号（已按设计稿缩放换算），不是排版原始值 */
  size: number;
  /** Photoshop 千分之一单位，换算 CSS 时 /1000 * size */
  tracking?: number;
  leading?: number;
  allCaps?: boolean;
  lineHeight?: number;
  letterSpacing?: number;
  color?: string;
  textAlign?: string;
  content?: string;
}

export interface LayerFill {
  type: string;
  color?: string;
  css?: string;
}

export interface LayerBorder extends LayerFill {
  /** 边框粗细 */
  width?: number;
  /** inside / outside / center */
  position?: string;
  style?: string;
}

/** 图层效果，`type` 为设计稿里的效果名（innerGlow / frameFX / dropShadow…） */
export interface LayerEffect {
  type: string;
  [key: string]: unknown;
}

export interface Layer {
  id: string;
  /** CoDesign 的 object_id，切图清单里用它关联图层 */
  objectId: string;
  name: string;
  type: string;
  rect: LayerRect;
  visible: boolean;
  opacity?: number;
  fillOpacity?: number;
  /** 圆角，按 topLeft/topRight/bottomRight/bottomLeft 顺序 */
  radius?: number[];
  fills?: LayerFill[];
  borders?: LayerBorder[];
  /** 阴影/发光/描边等效果 */
  effects?: LayerEffect[];
  /** 设计稿自带的 CSS 片段，是最可靠的样式来源 */
  css?: string[];
  text?: TextStyle;
  images?: string[];
  clipped?: boolean;
  blendMode?: string;
  rotation?: number;
  /** 图层带矢量路径 */
  isVector?: boolean;
  children?: Layer[];
}

export interface LayerTree {
  name: string;
  width: number;
  height: number;
  /** 已经按 parent_id 重建成真正的嵌套树 */
  layers: Layer[];
}

export interface SliceExport {
  name: string;
  scale: number;
  format: string;
  width: number;
  height: number;
  downloadUrl: string;
  objectId: string;
}

export interface SliceItem {
  id: string;
  name: string;
  rect: LayerRect;
  exports: SliceExport[];
}

export interface DownloadResult {
  name: string;
  /** 相对 outDir 的路径，便于调用方定位 */
  path: string;
  /** 实际使用的导出倍率（默认 2x；该图层没有时会就近取） */
  scale?: number;
  /** 该图层没有请求的倍率，实际用了另一个倍率 */
  substituted?: boolean;
  width: number;
  height: number;
  bytes: number;
  ok: boolean;
  error?: string;
}

export interface SpecNode {
  name: string;
  type: string;
  objectId: string;
  box: {
    left: number;
    top: number;
    width: number;
    height: number;
  };
  style: string[];
  text?: string;
}

export interface SpecResult {
  screen: string;
  size: { width: number; height: number };
  cssWidth: number;
  /** 设计稿宽度 -> 目标 CSS 宽度的缩放比 */
  scale: number;
  nodes: SpecNode[];
  slices: { name: string; left: number; top: number; width: number; height: number; scale: number; file: string }[];
  notes: string[];
  /** 图层被截断时的说明 */
  truncated?: { total: number; returned: number };
}
