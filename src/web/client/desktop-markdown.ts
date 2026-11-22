// Markdown preview support for the desktop editor. The decision logic lives
// here, away from the component, so the button, the shortcut and the tests all
// ask the same question about a path instead of each keeping its own list.

/** Extensions the preview renders. Anything else stays in the code editor. */
const MARKDOWN_EXTENSIONS = new Set(["md", "markdown", "mdx", "mdown", "mkd", "mdwn"]);

/** Editor language for a path, matching `editorLanguage` in desktop-syntax. */
function extensionOf(path: string): string {
  const name = path.split("/").at(-1) ?? "";
  if (!name) return "";
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** True for the Markdown documents the preview button applies to. */
export function isMarkdownPath(path: string): boolean {
  return MARKDOWN_EXTENSIONS.has(extensionOf(path));
}

export interface PreviewAction {
  /** Button face: the mode it switches to, the way VS Code labels the toggle. */
  label: string;
  title: string;
  pressed: boolean;
}

/**
 * The preview button's state for one document, or null when the file is not
 * Markdown — a disabled button on every `.ts` tab would be noise.
 */
export function previewAction(path: string, previewing: boolean): PreviewAction | null {
  if (!isMarkdownPath(path)) return null;
  return previewing
    ? { label: "编辑", title: "回到编辑(⌘/Ctrl+Shift+V)", pressed: true }
    : { label: "预览", title: "预览 Markdown(⌘/Ctrl+Shift+V)", pressed: false };
}

/**
 * ⌘/Ctrl+Shift+V toggles the preview, the same chord VS Code uses for
 * "Markdown: Open Preview to the Side". Plain ⌘V must keep pasting.
 */
export function isPreviewShortcut(event: { key: string; metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean }): boolean {
  return event.key.toLowerCase() === "v" && event.shiftKey === true && (event.metaKey === true || event.ctrlKey === true);
}

/** Every HTML tag, including self-closing ones and their attributes. */
const HTML_TAG = /<\/?[a-zA-Z][^<>]*>/gu;
const HTML_COMMENT = /<!--[\s\S]*?-->/gu;

/**
 * READMEs are markdown plus the HTML GitHub still accepts: centred banners,
 * `<sub>` captions, `<img>` logos, `<br>` inside table cells. Rendering that
 * literally filled the preview with tag soup, so the preview strips the markup
 * but keeps the text inside it. Chat rendering is untouched — this only shapes
 * the file being previewed.
 */
export function previewSource(content: string): string {
  return content
    // Script and style bodies are not document text; dropping only the tags
    // would leave their code behind as a paragraph.
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/giu, "")
    .replace(HTML_COMMENT, "")
    .replace(/<img\b[^>]*>/giu, tag => {
      const src = /\bsrc\s*=\s*["']([^"']+)["']/iu.exec(tag)?.[1] ?? "";
      const alt = /\balt\s*=\s*["']([^"']*)["']/iu.exec(tag)?.[1] ?? "";
      return src ? `![${alt}](${src})` : "";
    })
    .replace(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/giu, (_tag, href: string, text: string) => `[${text.replace(HTML_TAG, "").trim()}](${href})`)
    // Inside a table row a newline would end the row, so a hard break becomes a
    // space instead of splitting the cell in two.
    .replace(/<br\s*\/?>/giu, " ")
    .replace(HTML_TAG, "");
}
