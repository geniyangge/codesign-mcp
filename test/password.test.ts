import assert from "node:assert/strict";
import { test } from "node:test";

import { CoDesignClient, toCdnUrl } from "../src/client.js";
import { explainError, isCoDesignError } from "../src/errors.js";

// 密码分享相关逻辑的回归测试。
// 字段形态来自线上实测：接口返回的 JSON 会把中文转义成 \uXXXX。

const SHARE = 100000000000001;
const PWD = "ABCD";

/** 构造一个只响应特定路由的 fetch 桩 */
function stubFetch(routes: Record<string, (init?: RequestInit) => Response>) {
  return async (url: string, init?: RequestInit) => {
    for (const [key, handler] of Object.entries(routes)) {
      if (url.includes(key)) return handler(init);
    }
    return new Response(JSON.stringify({ message: "unexpected" }), { status: 404 });
  };
}

test("explainError: 转义后的「请输入密码」也能识别", () => {
  // 这是接口真实返回的字节形态，中文被转义
  const body = '{"message":"\u8bf7\u8f93\u5165\u5bc6\u7801\uff01","context":{"sharing_title":"示例设计稿"}}';
  const err = explainError(403, body, "u");
  assert.ok(isCoDesignError(err));
  assert.equal(err.code, "NEED_PASSWORD");
  // 提示里应带上分享标题，方便用户确认是哪个设计稿
  assert.match(err.message, /示例设计稿/);
  assert.match(err.hint ?? "", /password/);
});

test("explainError: 密码错误返回 INVALID_PASSWORD", () => {
  const body = '{"message":"\u5bc6\u7801\u9519\u8bef\uff01"}';
  const err = explainError(403, body, "u");
  assert.equal(err.code, "INVALID_PASSWORD");
});

test("explainError: 带 Cookie 时返回「暂无权限」提示可能是密码或权限问题", () => {
  const body = '{"message":"\u60a8\u5f53\u524d\u6682\u65e0\u6743\u9650"}';
  const err = explainError(403, body, "u");
  assert.equal(err.code, "NO_PERMISSION");
  assert.match(err.hint ?? "", /密码/);
});

test("交换密码后带 state-key 请求，且缓存避免重复换取", async (t) => {
  let stateKeyCalls = 0;
  let sharingCalls = 0;
  let seenStateKey: string | undefined;

  t.mock.method(
    globalThis,
    "fetch",
    stubFetch({
      "/state-keys": (init) => {
        stateKeyCalls++;
        const body = JSON.parse(String(init?.body ?? "{}"));
        assert.equal(body.password, PWD);
        return new Response(JSON.stringify({ key: "KEY-1", expires: Math.floor(Date.now() / 1000) + 600 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
      [`/api/sharings/${SHARE}`]: (init) => {
        sharingCalls++;
        seenStateKey = new Headers(init?.headers).get("state-key") ?? undefined;
        return new Response(
          JSON.stringify({
            id: SHARE,
            title: "示例设计稿",
            team: { name: "示例团队" },
            permissions: {},
            designs: [{ id: 1, name: "设计", sections: [{ screens: [{ id: 11, name: "首页" }] }] }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    }),
  );

  const client = new CoDesignClient("");
  const share = await client.getShare(SHARE, PWD);

  assert.equal(share.title, "示例设计稿");
  assert.equal(seenStateKey, "KEY-1");
  assert.equal(stateKeyCalls, 1);

  // 第二次走缓存，不再换 key
  await client.getShare(SHARE, PWD);
  assert.equal(stateKeyCalls, 1);
  assert.equal(sharingCalls, 2);
});

test("不带密码且被鉴权拦下时，用无 Cookie 探测确认需要密码", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async (url: string, init?: RequestInit) => {
      if (url.includes("/state-keys")) {
        return new Response(JSON.stringify({ key: "K", expires: Math.floor(Date.now() / 1000) + 600 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      const headers = new Headers(init?.headers);
      // 带 Cookie 的请求被拒（真实表现：暂无权限，而不是请输入密码）
      if (headers.get("cookie")) {
        return new Response('{"message":"\u60a8\u5f53\u524d\u6682\u65e0\u6743\u9650"}', { status: 403 });
      }
      // 不带 Cookie 的探测请求才暴露「需要密码」
      return new Response('{"message":"\u8bf7\u8f93\u5165\u5bc6\u7801\uff01"}', { status: 403 });
    },
  );

  const client = new CoDesignClient("access_token=t; X-Team-Id=1");
  await assert.rejects(
    () => client.getShare(SHARE),
    (e: any) => e.code === "NEED_PASSWORD" && /CODESIGN_PASSWORD/.test(e.hint ?? ""),
  );
});

test("环境变量里的默认密码可在未显式传参时兜底", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    stubFetch({
      "/state-keys": () =>
        new Response(JSON.stringify({ key: "K", expires: Math.floor(Date.now() / 1000) + 600 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      [`/api/sharings/${SHARE}`]: () =>
        new Response(
          JSON.stringify({ id: SHARE, title: "T", designs: [{ id: 1, name: "d", sections: [] }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    }),
  );

  const client = new CoDesignClient("", { defaultPassword: PWD });
  const share = await client.getShare(SHARE);
  assert.equal(share.title, "T");
});

test("toCdnUrl: 位图追加 imageMogr2，矢量格式跳过", () => {
  const png = toCdnUrl("https://cdn4.codesign.qq.com/a/b.png");
  assert.ok(png.endsWith("?imageMogr2/format/png"));

  // svg 加 imageMogr2 会让腾讯云返回 400 InvalidImageFormat
  const svg = toCdnUrl("https://cdn4.codesign.qq.com/a/b.svg");
  assert.equal(svg, "https://cdn4.codesign.qq.com/a/b.svg");

  // 显式传 format 时以 format 为准
  const svgNoExt = toCdnUrl("https://cdn4.codesign.qq.com/a/b", undefined, "svg");
  assert.equal(svgNoExt, "https://cdn4.codesign.qq.com/a/b");
});

test("CSS 字重支持数字与名称两种写法", async () => {
  const { buildSpec } = await import("../src/spec.js");
  const screen = { id: 1, name: "s", width: 750, height: 1334, designId: 1, source: "", slicesCount: 0 };
  const mk = (weight: string) => ({
    name: "x",
    width: 750,
    height: 1334,
    layers: [
      {
        id: "1",
        objectId: "1",
        name: "t",
        type: "text",
        rect: { x: 0, y: 0, width: 100, height: 20 },
        visible: true,
        text: { fontName: "F", fontStyleName: weight, size: 20 },
      },
    ],
  });

  // 线上数据里 fontStyleName 可能是数字 700，之前会崩在 toLowerCase
  const num = buildSpec(screen as any, mk("700") as any, [], {}).nodes[0].style.join("; ");
  assert.match(num, /font-weight:700/);

  const name = buildSpec(screen as any, mk("Bold") as any, [], {}).nodes[0].style.join("; ");
  assert.match(name, /font-weight:700/);
});
