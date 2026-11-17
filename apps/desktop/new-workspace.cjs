const { mkdir } = require("node:fs/promises");
const { join } = require("node:path");

async function chooseNewWorkspace(dialog, win, defaultPath) {
  const options = { title: "新建工作区文件夹", buttonLabel: "创建工作区", defaultPath: join(defaultPath, "新工作区"), properties: ["createDirectory", "showOverwriteConfirmation"] };
  const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
  if (result.canceled || !result.filePath) return undefined;
  // Never reuse or overwrite an existing file or directory.
  try { await mkdir(result.filePath); }
  catch (error) {
    if (error.code === "EEXIST") throw new Error("该位置已存在文件或文件夹，请为新工作区选择其他名称。");
    throw error;
  }
  return result.filePath;
}
module.exports = { chooseNewWorkspace };
