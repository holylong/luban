import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { mediaKind, mediaSource } from "./desktop-media";
import { DesktopMediaView } from "./desktop-media-view";

describe("desktop media preview", () => {
  it("classifies audio, video and image paths", () => {
    expect(mediaKind("clip.MP4")).toBe("video");
    expect(mediaKind("voice/note.m4a")).toBe("audio");
    expect(mediaKind("img/logo.png")).toBe("image");
    expect(mediaKind("src/app.ts")).toBeNull();
    expect(mediaKind("README")).toBeNull();
  });

  it("builds an encoded workspace URL", () => {
    expect(mediaSource("clip.mp4")).toBe("luban-media://workspace/clip.mp4");
    expect(mediaSource("/media/我的 视频.mp4")).toBe(`luban-media://workspace/media/${encodeURIComponent("我的 视频")}.mp4`);
  });

  it("renders a player instead of the text editor", () => {
    const video = renderToStaticMarkup(<DesktopMediaView path="clip.mp4" kind="video" />);
    expect(video).toContain("<video");
    expect(video).toContain("controls");
    expect(video).toContain("luban-media://workspace/clip.mp4");
    expect(video).not.toContain("<textarea");

    const audio = renderToStaticMarkup(<DesktopMediaView path="voice.mp3" kind="audio" />);
    expect(audio).toContain("<audio");

    const image = renderToStaticMarkup(<DesktopMediaView path="logo.png" kind="image" onClose={() => {}} />);
    expect(image).toContain("<img");
    expect(image).toContain("关闭预览");
  });
});
