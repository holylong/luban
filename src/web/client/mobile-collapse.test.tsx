import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MobileCollapse } from "./mobile-collapse";

const markup = (element: React.ReactElement): string => renderToStaticMarkup(element);

describe("MobileCollapse", () => {
  it("keeps a long list closed but still shows the current choice", () => {
    const html = markup(<MobileCollapse label="会话" ariaLabel="继续会话" summary="继续：整理右键菜单">
      <button>新会话</button>
    </MobileCollapse>);
    expect(html).toContain("继续：整理右键菜单");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-label="继续会话"');
    expect(html).not.toContain("新会话");
  });

  it("renders the rows when it opens", () => {
    const html = markup(<MobileCollapse label="可选模型" summary="deepseek-v4.1-flash" defaultOpen>
      <div role="listbox">模型行</div>
    </MobileCollapse>);
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("模型行");
    expect(html).toContain("deepseek-v4.1-flash");
  });

  it("labels the toggle even without a summary", () => {
    const html = markup(<MobileCollapse label="可选模型"><span>行</span></MobileCollapse>);
    expect(html).toContain('aria-label="可选模型"');
  });
});
