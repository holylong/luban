import React from "react";

export type FileIconKind = "folder" | "code" | "image" | "pdf" | "word" | "sheet" | "slides" | "diagram" | "audio" | "video" | "archive" | "config" | "markdown" | "text" | "database" | "file";

const groups: Partial<Record<FileIconKind, string>> = {
  code: "ts tsx js jsx mjs cjs mts cts py pyw go rs java kt kts swift c h cpp hpp cc cs rb php vue svelte html htm css scss sass less sh bash zsh fish ps1 bat cmd sql lua r dart ex exs erl clj scala asm",
  image: "png jpg jpeg gif webp svg bmp ico icns avif heic tiff tif",
  pdf: "pdf",
  word: "doc docx docm odt rtf pages",
  sheet: "xls xlsx xlsm xltx csv tsv ods numbers",
  slides: "ppt pptx pptm pps ppsx odp key",
  diagram: "drawio dio vsd vsdx",
  audio: "mp3 wav ogg oga m4a aac flac opus aiff wma",
  video: "mp4 webm mov m4v mkv avi ogv mpeg mpg wmv",
  archive: "zip gz tgz bz2 xz zst tar rar 7z jar war apk dmg iso deb rpm",
  config: "json jsonc yaml yml toml ini conf config env xml plist properties lock",
  markdown: "md mdx markdown rst",
  text: "txt log tex adoc",
  database: "db sqlite sqlite3 mdb parquet arrow",
};
const extensions = new Map(Object.entries(groups).flatMap(([kind, list]) => list.split(" ").map(extension => [extension, kind as FileIconKind] as const)));

/** Filename-only classification: no file reads, MIME requests or external icons. */
export function fileIconKind(path: string, directory = false): FileIconKind {
  if (directory) return "folder";
  const name = path.split(/[\\/]/).pop()!.toLowerCase();
  // Embedded draw.io documents are diagrams, not ordinary PNG/SVG/XML images.
  if (/\.drawio\.(png|svg|xml)$/.test(name)) return "diagram";
  if (/^\.env(?:\.|$)/.test(name) || /^\.(gitignore|gitattributes|editorconfig|npmrc|nvmrc|prettierrc|eslintrc)(?:\.|$)/.test(name)) return "config";
  if (/^(dockerfile|makefile|cmakelists\.txt)(?:\.|$)/.test(name)) return "code";
  if (/^(readme|license|licence|changelog|authors|notice)$/.test(name)) return "text";
  return extensions.get(name.includes(".") ? name.split(".").pop()! : "") ?? "file";
}

const labels: Record<FileIconKind, string> = {
  folder: "文件夹", code: "代码", image: "图片", pdf: "PDF", word: "文档", sheet: "表格", slides: "幻灯片", diagram: "图形", audio: "音频", video: "视频", archive: "压缩包 / 安装包", config: "配置", markdown: "Markdown", text: "文本", database: "数据库", file: "文件",
};
const colors: Record<FileIconKind, string> = {
  folder: "#d5ad62", code: "#78b7ef", image: "#b49ae8", pdf: "#ef8b87", word: "#78aef0", sheet: "#76c69a", slides: "#e9a16b", diagram: "#d4aa75", audio: "#d99bdb", video: "#b49ae8", archive: "#d5ad62", config: "#9ba8bd", markdown: "#80c4d6", text: "#a8b5c8", database: "#d5ad62", file: "#a8b5c8",
};

/** Small inline SVGs keep shapes and colours identical across desktop platforms. */
export function DesktopFileIcon({ path, directory = false, expanded = false }: {
  path: string; directory?: boolean; expanded?: boolean;
}): React.ReactElement {
  const kind = fileIconKind(path, directory);
  let drawing: React.ReactNode;
  switch (kind) {
    case "folder": drawing = expanded
      ? <><path d="M2 7V4h6l2 2h8v3" /><path d="M2 7h6l2 2h10l-3 9H3Z" /></>
      : <path d="M2 18V4h6l2 2h10v12Z" />; break;
    case "code": drawing = <><path d="m7 7-5 5 5 5m10-10 5 5-5 5m-3-13-4 16" /></>; break;
    case "image": drawing = <><rect x="2" y="3" width="20" height="18" rx="2" /><circle cx="8" cy="8" r="2" /><path d="m3 19 6-6 4 4 4-6 5 8" /></>; break;
    case "audio": drawing = <><path d="M9 17V5l11-2v12M9 8l11-2" /><ellipse cx="6" cy="18" rx="3" ry="2" /><ellipse cx="17" cy="16" rx="3" ry="2" /></>; break;
    case "video": drawing = <><rect x="2" y="4" width="20" height="16" rx="2" /><path d="m10 8 6 4-6 4Z" /></>; break;
    case "diagram": drawing = <><rect x="8" y="2" width="8" height="6" rx="1" /><rect x="1" y="16" width="8" height="6" rx="1" /><rect x="15" y="16" width="8" height="6" rx="1" /><path d="M12 8v4H5v4m7-4h7v4" /></>; break;
    case "database": drawing = <><ellipse cx="12" cy="5" rx="9" ry="3" /><path d="M3 5v14c0 4 18 4 18 0V5M3 12c0 4 18 4 18 0" /></>; break;
    default: {
      const badges: Partial<Record<FileIconKind, string>> = { pdf: "PDF", word: "W", sheet: "X", slides: "P", archive: "Z", config: "{}", markdown: "M" };
      const badge = badges[kind];
      drawing = <><path d="M4 2h10l6 6v14H4Z" /><path d="M14 2v6h6" />
        {badge ? <text x="12" y="18" textAnchor="middle" fill="currentColor" stroke="none" fontSize={kind === "pdf" ? 6 : 10} fontFamily="sans-serif" fontWeight="700">{badge}</text>
          : <path d="M8 12h8M8 16h8" />}</>;
    }
  }
  return <span className={`desktop-file-icon desktop-file-icon-${kind}`} title={labels[kind]} aria-hidden="true" style={{ color: colors[kind] }}>
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" focusable="false">{drawing}</svg>
  </span>;
}
