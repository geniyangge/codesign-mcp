import assert from "node:assert/strict";
import { test } from "node:test";

import { parseScreenId, parseShareId, toCdnUrl } from "../src/client.js";
import { CoDesignError } from "../src/errors.js";
import { mapLimit } from "../src/utils/concurrency.js";
import { createNamer, sanitizeFilename } from "../src/utils/filename.js";

test("parseShareId 兼容各种分享链接写法", () => {
  assert.equal(parseShareId("https://codesign.qq.com/app/s/100000000000001"), 100000000000001);
  assert.equal(parseShareId("https://codesign.qq.com/app/s/100000000000001/100000000000002"), 100000000000001);
  assert.equal(parseShareId("https://codesign.qq.com/#/app/s/100000000000001"), 100000000000001);
  assert.equal(parseShareId("https://codesign.qq.com/s/100000000000001"), 100000000000001);
  assert.equal(parseShareId("  100000000000001  "), 100000000000001);
});

test("parseShareId 无法解析时抛出带提示的 CoDesignError", () => {
  assert.throws(
    () => parseShareId("https://example.com/foo"),
    (e: unknown) => e instanceof CoDesignError && Boolean(e.hint),
  );
});

test("parseScreenId 只在带画板 ID 时返回", () => {
  assert.equal(parseScreenId("https://codesign.qq.com/app/s/100000000000001/100000000000002"), 100000000000002);
  assert.equal(parseScreenId("https://codesign.qq.com/app/s/100000000000001"), undefined);
});

test("toCdnUrl 把 OSS 签名直链换成 CDN 域名并追加 imageMogr2", () => {
  const out = toCdnUrl("https://bucket.oss-cn-shenzhen.aliyuncs.com/a/b.png?Signature=x");
  assert.ok(out.startsWith("https://cdn4.codesign.qq.com/a/b.png?Signature=x"));
  assert.ok(out.endsWith("&imageMogr2/format/png"));
});

test("toCdnUrl 不重复追加 imageMogr2", () => {
  const already = "https://cdn4.codesign.qq.com/a.png?imageMogr2/format/png";
  assert.equal(toCdnUrl(already), already);
});

test("toCdnUrl 保留签名参数的原有顺序", () => {
  const out = toCdnUrl("https://cdn4.codesign.qq.com/a.png?Expires=1&Signature=x");
  assert.ok(out.endsWith("&imageMogr2/format/png"));
  assert.ok(out.includes("Expires=1&Signature=x"));
});

test("toCdnUrl 遇到空值或非法 URL 原样返回", () => {
  assert.equal(toCdnUrl(""), "");
  assert.equal(toCdnUrl("not a url"), "not a url");
});

test("sanitizeFilename 替换非法字符但保留空格与连字符", () => {
  assert.equal(sanitizeFilename("icon/home"), "icon_home");
  assert.equal(sanitizeFilename('a:b*c?"d"<e>|f'), "a_b_c__d__e__f");
  assert.equal(sanitizeFilename("btn-primary copy"), "btn-primary copy");
  assert.equal(sanitizeFilename("name."), "name");
  assert.equal(sanitizeFilename(""), "unnamed");
});

test("sanitizeFilename 处理 Windows 保留名", () => {
  assert.equal(sanitizeFilename("CON"), "_CON");
  assert.equal(sanitizeFilename("com1.png"), "_com1.png");
});

test("createNamer 对同名文件追加序号且不区分大小写", () => {
  const name = createNamer();
  assert.equal(name("icon", "png"), "icon.png");
  assert.equal(name("icon", "png"), "icon_2.png");
  // 大小写不同的同名文件视为冲突（避免在 Windows/macOS 上互相覆盖），但保留原始大小写
  assert.equal(name("ICON", "PNG"), "ICON_3.PNG");
  assert.equal(name("icon", "svg"), "icon.svg");
});

test("mapLimit 按并发度执行且保持结果顺序", async () => {
  let inFlight = 0;
  let peak = 0;
  const items = Array.from({ length: 20 }, (_, i) => i);

  const out = await mapLimit(items, 4, async (n) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    return n * 2;
  });

  assert.deepEqual(out, items.map((n) => n * 2));
  assert.ok(peak <= 4, `并发峰值 ${peak} 超过上限`);
  assert.ok(peak > 1, "没有真正并发执行");
});

test("mapLimit 处理空数组与非法并发度", async () => {
  assert.deepEqual(await mapLimit([], 4, async (n: number) => n), []);
  assert.deepEqual(await mapLimit([1, 2], 0, async (n) => n), [1, 2]);
});
