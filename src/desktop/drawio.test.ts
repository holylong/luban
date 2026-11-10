import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { deflateRawSync, deflateSync } from "node:zlib";

const { readDrawio, readDrawioPng, plainLabel } = createRequire(import.meta.url)("../../apps/desktop/drawio.cjs");

const page = `<mxGraphModel><root>
<mxCell id="0"/><mxCell id="1" parent="0"/>
<mxCell id="a" value="开始 &lt;b&gt;流程&lt;/b&gt;" style="rounded=1;fillColor=#dae8fc;strokeColor=#6c8ebf;" vertex="1" parent="1"><mxGeometry x="40" y="40" width="140" height="60" as="geometry"/></mxCell>
<mxCell id="b" value="结束" style="ellipse;whiteSpace=wrap;html=1;fillColor=#d5e8d4;" vertex="1" parent="1"><mxGeometry x="320" y="200" width="120" height="70" as="geometry"/></mxCell>
<mxCell id="e" value="下一步" style="edgeStyle=orthogonalEdgeStyle;endArrow=classic;" edge="1" parent="1" source="a" target="b"><mxGeometry relative="1" as="geometry"/></mxCell>
</root></mxGraphModel>`;

const mxfile = (content: string, name = "流程") => `<mxfile host="app.diagrams.net"><diagram id="p1" name="${name}">${content}</diagram></mxfile>`;

describe("draw.io preview", () => {
  it("reads vertices, edges and labels from plain XML", () => {
    const model = readDrawio(mxfile(page));
    expect(model.kind).toBe("diagram");
    expect(model.pages).toHaveLength(1);
    const [first] = model.pages;
    expect(first.name).toBe("流程");
    expect(first.nodes).toHaveLength(2);
    expect(first.nodes[0]).toMatchObject({ kind: "roundRect", x: 40, y: 40, w: 140, h: 60, fill: "#dae8fc", stroke: "#6c8ebf" });
    expect(first.nodes[0].lines).toEqual(["开始 流程"]);
    expect(first.nodes[1]).toMatchObject({ kind: "ellipse", fill: "#d5e8d4", stroke: "#000000" });
    expect(first.edges).toHaveLength(1);
    expect(first.edges[0].points).toHaveLength(4);
    expect(first.edges[0]).toMatchObject({ label: "下一步", arrow: true });
    // The viewBox is padded around the shapes so nothing clips.
    expect(first.view.x).toBe(16);
    expect(first.view.y).toBe(16);
    expect(first.view.width).toBe(448);
    expect(first.view.height).toBe(278);
  });

  it("accepts a bare mxGraphModel and decompresses a compressed page", () => {
    const bare = readDrawio(page);
    expect(bare.pages[0].nodes).toHaveLength(2);
    const compressed = deflateRawSync(Buffer.from(encodeURIComponent(page))).toString("base64");
    const packed = readDrawio(`<mxfile><diagram id="c" name="压缩">${compressed}</diagram></mxfile>`);
    expect(packed.pages[0].name).toBe("压缩");
    expect(packed.pages[0].nodes[0].lines).toEqual(["开始 流程"]);
  });

  it("finds the diagram embedded in a .drawio.svg file", () => {
    const escaped = mxfile(page).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><content type="application/x-drawio">${escaped}</content><rect width="10" height="10"/></svg>`;
    expect(readDrawio(svg).pages[0].nodes).toHaveLength(2);
  });

  it("reads the mxfile chunk of a .drawio.png preview", () => {
    const chunk = (type: string, data: Buffer) => {
      const header = Buffer.alloc(8);
      header.writeUInt32BE(data.length, 0);
      header.write(type, 4, "latin1");
      const crc = Buffer.alloc(4);
      return Buffer.concat([header, data, crc]);
    };
    const text = (key: string, body: Buffer) => Buffer.concat([Buffer.from(`${key}\0`, "latin1"), body]);
    const xml = mxfile(page);
    const png = Buffer.concat([
      Buffer.from("89504e470d0a1a0a", "hex"),
      chunk("zTXt", text("mxfile", Buffer.concat([Buffer.from([0]), deflateSync(Buffer.from(xml))]))),
      chunk("IEND", Buffer.alloc(0)),
    ]);
    expect(readDrawioPng(png).pages[0].nodes).toHaveLength(2);
    expect(() => readDrawioPng(Buffer.from("89504e470d0a1a0a", "hex"))).toThrow(/内嵌/);
  });

  it("strips HTML labels and rejects unrelated files", () => {
    expect(plainLabel("<b>标题</b><br>第二行")).toBe("标题\n第二行");
    expect(plainLabel("a &amp; b")).toBe("a & b");
    expect(() => readDrawio("just text")).toThrow(/draw\.io/);
  });
});
