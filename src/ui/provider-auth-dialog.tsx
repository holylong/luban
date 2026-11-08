import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { spawn, type ChildProcess } from "node:child_process";
import { stripVTControlCharacters } from "node:util";
import { readProviderKeys, saveProviderKey } from "../core/provider-auth.js";
import { codexInvocation } from "../core/codex-command.js";
import { readCodexAuth } from "../core/codex-auth.js";
import { openExternal } from "./links.js";
import { theme } from "./theme.js";

const KEY_URLS: Record<string, string> = {
  "opencode-go": "https://opencode.ai/auth", "opencode-zen": "https://opencode.ai/auth",
  deepseek: "https://platform.deepseek.com/api_keys", dashscope: "https://bailian.console.aliyun.com/",
  opendesign: "https://open-design.ai/", anthropic: "https://console.anthropic.com/settings/keys",
  openai: "https://platform.openai.com/api-keys",
};

/** Secrets stay in this component, never the composer, history or transcript. */
export function ProviderAuthDialog({ home, provider, configured, onChanged, onClose }: {
  home: string; provider: string; configured: boolean;
  onChanged(key: string | null | undefined): void; onClose(): void;
}): React.ReactElement {
  const codex = provider === "codex";
  const [mode, setMode] = useState<"menu" | "key" | "remove" | "login">("menu");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(() => Boolean(readProviderKeys(home)[provider]));
  const [message, setMessage] = useState("");
  const [output, setOutput] = useState("");
  const childRef = useRef<ChildProcess | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; childRef.current?.kill(); }, []);
  useEffect(() => {
    if (codex) void readCodexAuth().then(auth => { if (alive.current && auth) setMessage("已检测到 ChatGPT 登录（未验证在线状态）"); });
  }, [codex]);

  const save = async (key: string | null): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      await saveProviderKey(home, provider, key);
      if (!alive.current) return;
      setSecret(""); setSaved(key !== null); setMode("menu");
      setMessage(key === null ? "已移除 luban 保存的 Key；恢复环境变量/配置/外部凭据。" : "API Key 已保存并生效（尚未向服务商验证）。");
      onChanged(key);
    } catch {
      if (alive.current) setMessage("保存失败：请检查用户凭据文件权限与格式，Key 不能为空或包含控制字符。");
    } finally { if (alive.current) setBusy(false); }
  };

  const login = (): void => {
    setMode("login"); setBusy(true); setOutput(""); setMessage("正在启动 Codex 设备码登录；请打开下方官方链接并输入设备码。");
    try {
      const child = spawn(...codexInvocation(["login", "--device-auth"]), { stdio: ["ignore", "pipe", "pipe"] });
      childRef.current = child;
      const append = (chunk: Buffer): void => {
        if (alive.current) setOutput(current => (current + stripVTControlCharacters(chunk.toString())).slice(-4000));
      };
      child.stdout?.on("data", append); child.stderr?.on("data", append);
      child.once("error", () => {
        if (!alive.current || childRef.current !== child) return;
        childRef.current = null; setBusy(false);
        setMessage("无法启动 Codex CLI，请先安装 @openai/codex，或设置 LUBAN_CODEX_BIN。");
      });
      child.once("close", code => {
        if (!alive.current || childRef.current !== child) return;
        childRef.current = null; setBusy(false);
        setMessage(code === 0 ? "ChatGPT 登录完成。" : "登录未完成；可按 L 重试，Esc 返回。");
        if (code === 0) onChanged(undefined);
      });
    } catch {
      setBusy(false); setMessage("无法启动 Codex CLI，请先安装 @openai/codex，或设置 LUBAN_CODEX_BIN。");
    }
  };

  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === "c")) {
      if (busy && mode !== "login") return;
      childRef.current?.kill(); childRef.current = null; setBusy(false);
      if (mode !== "menu") { setSecret(""); setMode("menu"); setOutput(""); }
      else onClose();
      return;
    }
    if (busy) return;
    if (mode === "key") {
      if (key.return) { void save(secret.trim()); return; }
      if (key.backspace || key.delete) setSecret(current => current.slice(0, -1));
      else if (key.ctrl && input === "u") setSecret("");
      else if (input && !key.ctrl && !key.meta) setSecret(current => (current + input).slice(0, 8192));
      return;
    }
    if (mode === "remove") {
      if (input.toLowerCase() === "y") void save(null);
      else if (input.toLowerCase() === "n") setMode("menu");
      return;
    }
    if (codex && input.toLowerCase() === "l") { login(); return; }
    if (!codex && input.toLowerCase() === "k") { setMode("key"); setMessage(""); return; }
    if (!codex && saved && input.toLowerCase() === "d") { setMode("remove"); return; }
    if (input.toLowerCase() === "o" && KEY_URLS[provider]) {
      void openExternal(KEY_URLS[provider]!).catch(() => setMessage(`请在浏览器打开 ${KEY_URLS[provider]}`));
    }
  });

  return <Box flexDirection="column" marginTop={1}>
    <Text bold color={theme.muted}>Provider 鉴权 · {provider}</Text>
    <Text color={theme.muted}>{codex ? "ChatGPT / Codex 账号登录（需要已安装 Codex CLI）" : saved ? "状态：已保存 luban API Key" : configured ? "状态：已有配置/环境/外部凭据（未验证）" : "状态：尚未配置 Key（本地服务可能无需鉴权）"}</Text>
    <Text color={theme.dim}>密钥仅保存在用户目录 {home}/provider-auth.json，不写入项目或会话。</Text>
    <Text color={theme.dim}>本地明文存储；Unix 文件权限 0600。保存值优先于配置与环境变量。</Text>
    {mode === "key" ? <><Text>API Key: {"•".repeat(Math.min(secret.length, 48))}▏</Text><Text color={theme.dim}>输入或粘贴 · Enter 保存 · Ctrl+U 清空 · Esc 取消</Text></> : null}
    {mode === "remove" ? <Text color={theme.yellow}>仅删除 luban 保存的 Key？Y 确认 / N 取消（不会删除环境变量或外部登录）</Text> : null}
    {mode === "menu" ? <Text>{codex ? "L 登录 / 重新登录" : `K 设置 / 更新 API Key${saved ? " · D 删除保存的 Key" : ""}`}{KEY_URLS[provider] ? " · O 打开密钥控制台" : ""} · Esc 返回模型列表</Text> : null}
    {mode === "login" ? <><Text color={theme.dim}>设备码仅用于本次登录，不会写入会话。Esc 取消；完成后 Esc 返回。</Text><Text>{output.split(/\r?\n/).slice(-9).join("\n")}</Text></> : null}
    {message ? <Text color={theme.yellow}>{message}</Text> : null}
    {busy && mode !== "login" ? <Text>正在保存…</Text> : null}
  </Box>;
}
