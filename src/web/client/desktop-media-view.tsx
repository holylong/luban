import React from "react";
import { mediaSource, type MediaKind } from "./desktop-media";

/** Read-only playback for audio/video and a lightbox for images. These files are
 * binary, so the text editor refuses them; the workspace protocol streams them. */
export function DesktopMediaView({ path, kind, onClose }: {
  path: string;
  kind: MediaKind;
  onClose?(): void;
}): React.ReactElement {
  const source = mediaSource(path);
  const label = kind === "video" ? "视频播放" : kind === "audio" ? "音频播放" : "图片预览";
  return <div className="desktop-media">
    <div className="desktop-media-stage">
      {kind === "video" ? <video src={source} controls playsInline preload="metadata" aria-label={`播放 ${path}`} />
        : kind === "audio" ? <audio src={source} controls preload="metadata" aria-label={`播放 ${path}`} />
          : <img src={source} alt={path} />}
    </div>
    <div className="desktop-media-hint"><span>{`${path} · ${label} · 只读，不参与编辑`}</span>{onClose && <button onClick={onClose}>关闭预览</button>}</div>
  </div>;
}
