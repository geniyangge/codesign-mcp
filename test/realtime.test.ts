import assert from "node:assert/strict";
import { test } from "node:test";

import { buildLayerTree, CoDesignClient, rgba } from "../src/client.js";
import { buildSpec } from "../src/spec.js";
import type { ScreenDetail } from "../src/types.js";

// 这里的样例数据都是构造出来的中性占位值，不对应任何真实设计稿，
// 只复现线上接口的字段形态，用于锁死解析逻辑。

const screen: ScreenDetail = {
  id: 1,
  name: "示例画板",
  width: 750,
  height: 1334,
  designId: 2,
  source: "",
  slicesCount: 0,
};

// ---- 真实数据回归：这些字段形态都来自线上接口实测 ----

test("rgba: alpha 可能是 0–1，也可能是 0–100", () => {
  // 普通颜色 a=1
  assert.equal(rgba({ r: 255, g: 255, b: 255, a: 1, "color-hex": "#FFFFFF 100%" }), "#FFFFFF");
  // 半透明遮罩：a=100 且 color-hex 也是百分比
  assert.equal(rgba({ r: 0, g: 0, b: 0, a: 100, "color-hex": "#000000 10000%" }), "#000000");
  // a 字段与 color-hex 矛盾时以 a 为准
  assert.equal(rgba({ r: 255, g: 0, b: 0, a: 50, "color-hex": "#FF0000 100%" }), "#FF000080");
  assert.equal(rgba({ r: 255, g: 0, b: 0, a: 0.5 }), "rgba(255,0,0,0.5)");
});

test("rgba: 非法的 css-rgba alpha 会被纠正", () => {
  assert.equal(rgba({ "css-rgba": "rgba(0,0,0,100)" }), "rgb(0,0,0)");
  assert.equal(rgba({ "css-rgba": "rgba(0,0,0,0.4)" }), "rgba(0,0,0,0.4)");
});

test("buildLayerTree: 用 parent_id 从扁平 layers+groups 重建层级", () => {
  // 线上 meta 的形态：groups 与 layers 平铺，靠 parent_id 关联
  const nodes = [
    { object_id: "100", parent_id: "", type: "artboard", name: "画板", rect: { x: 0, y: 0, width: 750, height: 1334 } },
    { object_id: "110", parent_id: "100", type: "group", name: "头部", rect: { x: 0, y: 0, width: 750, height: 200 } },
    { object_id: "120", parent_id: "100", type: "group", name: "内容区", rect: { x: 0, y: 200, width: 750, height: 400 } },
    { object_id: "121", parent_id: "120", type: "group", name: "卡片", rect: { x: 20, y: 220, width: 710, height: 300 } },
    { object_id: "122", parent_id: "121", type: "shape", name: "卡片底", rect: { x: 20, y: 220, width: 710, height: 300 } },
    { object_id: "130", parent_id: "100", type: "shape", name: "散图层", rect: { x: 0, y: 0, width: 10, height: 10 } },
  ];

  const tree = buildLayerTree(nodes, "100");
  assert.deepEqual(tree.map((l) => l.name), ["头部", "内容区", "散图层"]);
  assert.equal(tree[1].children?.[0].name, "卡片");
  assert.equal(tree[1].children?.[0].children?.[0].name, "卡片底");
  // 画板自身不进入树
  assert.ok(!tree.some((l) => l.name === "画板"));
});

test("buildLayerTree: 没有父节点信息时不丢图层", () => {
  const nodes = [
    { object_id: "a", parent_id: "unknown-root", type: "shape", name: "A", rect: { x: 0, y: 0, width: 1, height: 1 } },
    { object_id: "b", parent_id: "a", type: "shape", name: "B", rect: { x: 0, y: 0, width: 1, height: 1 } },
  ];
  const tree = buildLayerTree(nodes, "missing");
  assert.equal(tree.length, 1);
  assert.equal(tree[0].name, "A");
  assert.equal(tree[0].children?.[0].name, "B");
});

test("buildLayerTree: 父引用成环时不会无限递归", () => {
  const nodes = [
    { object_id: "x", parent_id: "y", type: "group", name: "X", rect: { x: 0, y: 0, width: 1, height: 1 } },
    { object_id: "y", parent_id: "x", type: "group", name: "Y", rect: { x: 0, y: 0, width: 1, height: 1 } },
  ];
  // 不应抛栈溢出
  const tree = buildLayerTree(nodes, "root");
  assert.ok(Array.isArray(tree));
});

test("字号取 impliedFontSize 而不是会被缩放的 textStyle.size", async (t) => {
  const client = new CoDesignClient("");
  t.mock.method(globalThis, "fetch", async () =>
    new Response(
      JSON.stringify({
        name: "示例画板",
        width: 750,
        height: 1334,
        object_id: "100",
        layers: [
          {
            object_id: "110",
            parent_id: "100",
            type: "text",
            name: "示例文案",
            rect: { x: 100, y: 200, width: 150, height: 30 },
            visible: true,
            text: {
              textKey: "示例文案",
              textStyleRange: [
                {
                  textStyle: {
                    fontName: "Example Sans",
                    fontStyleName: "Heavy",
                    size: 30,
                    impliedFontSize: 25.5,
                    impliedLeading: 30,
                    fontCaps: "allCaps",
                    color: { r: 255, g: 255, b: 255, a: 1, "color-hex": "#FFFFFF 100%" },
                  },
                },
              ],
            },
            lineHeight: 30,
          },
        ],
        groups: [],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  );

  const tree = await client.getMeta("https://cdn4.codesign.qq.com/meta.json");
  const text = tree.layers[0].text!;
  assert.equal(text.size, 25.5);
  assert.equal(text.lineHeight, 30);
  // fontCaps: allCaps 在线上数据里普遍出现在普通文本上，不能据此加大写
  assert.equal(text.allCaps, false);
  assert.equal(text.content, "示例文案");
});

test("图层自带的 css 优先用于样式，且非法 alpha 被修正", () => {
  const tree = {
    name: "示例画板",
    width: 750,
    height: 1334,
    layers: [
      {
        id: "120",
        objectId: "120",
        name: "渐变块",
        type: "shape",
        rect: { x: 0, y: 0, width: 100, height: 50 },
        visible: true,
        radius: [20, 20, 20, 20],
        css: [
          "width:100px",
          "height:50px",
          "border-radius: 20px 20px 20px 20px",
          "background: linear-gradient(90deg, rgba(255,0,0,100),rgba(0,0,255,100))",
        ],
      },
    ],
  };

  const spec = buildSpec(screen, tree as any, [], { cssWidth: 375 });
  const style = spec.nodes[0].style.join("; ");
  assert.match(style, /width:50\.00px/);
  assert.match(style, /border-radius: 10\.00px/);
  // CoDesign 输出的 rgba(...,100) 是非法 CSS，必须归一成 rgb(...)
  assert.match(style, /rgb\(255,0,0\)/);
  assert.ok(!style.includes(",100)"), "残留非法 alpha: " + style);
});

test("边框带 thickness/position 时输出完整 border", () => {
  const tree = {
    name: "示例画板",
    width: 750,
    height: 1334,
    layers: [
      {
        id: "1",
        objectId: "1",
        name: "描边",
        type: "shape",
        rect: { x: 0, y: 0, width: 100, height: 100 },
        visible: true,
        borders: [{ type: "color", color: "#ffffff", width: 4, position: "inside", style: "inset" }],
      },
    ],
  };

  const spec = buildSpec(screen, tree as any, [], { cssWidth: 750 });
  assert.ok(spec.nodes[0].style.some((s) => s === "border:4.00px inset #ffffff"));
});

test("组图层会出现在结果里并带上层级缩进", () => {
  const tree = {
    name: "示例画板",
    width: 750,
    height: 1334,
    layers: [
      {
        id: "g",
        objectId: "g",
        name: "组",
        type: "group",
        rect: { x: 0, y: 0, width: 100, height: 100 },
        visible: true,
        children: [
          {
            id: "c",
            objectId: "c",
            name: "子",
            type: "shape",
            rect: { x: 10, y: 10, width: 50, height: 50 },
            visible: true,
          },
        ],
      },
    ],
  };

  const spec = buildSpec(screen, tree as any, [], {});
  assert.deepEqual(spec.nodes.map((n) => n.name), ["组", "  子"]);
  assert.equal(spec.nodes[1].objectId, "c");
});
