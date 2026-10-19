import assert from "node:assert/strict";
import { test } from "node:test";

import { CoDesignClient, toCdnUrl } from "../src/client.js";

test("toCdnUrl 保留签名参数顺序（回归：不能重排 OSS 签名）", () => {
  const out = toCdnUrl("https://cdn4.codesign.qq.com/x.png?a=1&b=2");
  assert.equal(out, "https://cdn4.codesign.qq.com/x.png?a=1&b=2&imageMogr2/format/png");
});

test("getShare 解析画板列表", async (t) => {
  const client = new CoDesignClient("");
  t.mock.method(globalThis, "fetch", async () =>
    new Response(
      JSON.stringify({
        id: 1,
        title: "设计稿",
        team: { name: "团队" },
        permissions: { commentable: true, inspectable: true, assetsDownloadable: false },
        designs: [
          {
            id: 10,
            name: "设计",
            viewport: "mobile",
            sections: [{ screens: [{ id: 100, name: "首页" }, { id: 101, name: "详情" }] }],
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  );

  const share = await client.getShare(1);
  assert.equal(share.title, "设计稿");
  assert.equal(share.teamName, "团队");
  assert.equal(share.permissions.assetsDownloadable, false);
  assert.deepEqual(share.designs[0].screens, [
    { id: 100, name: "首页" },
    { id: 101, name: "详情" },
  ]);
});

test("未配 Cookie 时读取画板详情抛出带指引的错误", async () => {
  const client = new CoDesignClient("");
  await assert.rejects(
    () => client.getScreen(10, 100),
    (e: any) => e.name === "CoDesignError" && /CODESIGN_COOKIE/.test(e.hint ?? ""),
  );
});

test("鉴权请求同时带 Cookie 与 Bearer，缺失时给出提示", async (t) => {
  const client = new CoDesignClient("access_token=abc; X-Team-Id=42");
  let seen: Headers | undefined;

  t.mock.method(globalThis, "fetch", async (_url: string, init: any) => {
    seen = new Headers(init.headers);
    return new Response(
      JSON.stringify({ id: 100, name: "首页", width: 750, height: 1334, meta_url: "/m.json" }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });

  const detail = await client.getScreen(10, 100);
  assert.equal(seen?.get("cookie"), "access_token=abc; X-Team-Id=42");
  assert.equal(seen?.get("authorization"), "Bearer abc");
  assert.equal(seen?.get("x-team-id"), "42");
  assert.equal(detail.metaUrl, "https://cdn4.codesign.qq.com/m.json");
});

test("403 会翻译成可操作提示", async (t) => {
  const client = new CoDesignClient("");
  t.mock.method(globalThis, "fetch", async () => new Response("forbidden", { status: 403 }));

  await assert.rejects(
    () => client.getShare(1),
    (e: any) => e.name === "CoDesignError" && /Origin/.test(e.hint ?? ""),
  );
});

test("5xx 会重试，4xx 不重试", async (t) => {
  const client = new CoDesignClient("", { retries: 2 });
  let attempts = 0;

  t.mock.method(globalThis, "fetch", async () => {
    attempts++;
    if (attempts < 3) return new Response("boom", { status: 502 });
    return new Response(JSON.stringify({ id: 1, designs: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

  const share = await client.getShare(1);
  assert.equal(share.id, 1);
  assert.equal(attempts, 3);

  attempts = 0;
  t.mock.method(globalThis, "fetch", async () => {
    attempts++;
    return new Response("nope", { status: 404 });
  });
  await assert.rejects(() => client.getShare(1));
  assert.equal(attempts, 1);
});
