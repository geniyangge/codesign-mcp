/**
 * 把图层名/画板名转成安全文件名。
 * Windows 保留名（CON、NUL、COM1…）和非法的尾部点/空格也要处理，否则写文件会失败。
 */
export function sanitizeFilename(name: string, fallback = "unnamed"): string {
  let out = name
    // 保留空格和连字符，只替换真正非法的字符与控制字符
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, "_")
    // Windows 不允许文件名以 . 或空格结尾
    .replace(/[. ]+$/, "")
    .trim();

  if (
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(out) ||
    out.length > 120
  ) {
    out = out.replace(/^(con|prn|aux|nul|com[1-9]|lpt[1-9])/i, "_$1").slice(0, 120);
  }

  return out || fallback;
}

/**
 * 同名文件去重：第二次出现起追加 `_2`、`_3`…
 * 返回一个可复用的命名器，同一目录内共享才能跨画板/跨批次去重。
 */
export function createNamer() {
  const used = new Map<string, number>();
  // 不区分大小写，避免 a.png / A.png 在 macOS/Windows 上互相覆盖
  return (base: string, ext: string): string => {
    const key = `${base}.${ext}`.toLowerCase();
    const n = (used.get(key) ?? 0) + 1;
    used.set(key, n);
    return n === 1 ? `${base}.${ext}` : `${base}_${n}.${ext}`;
  };
}
