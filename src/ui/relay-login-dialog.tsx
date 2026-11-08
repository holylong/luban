import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { loginRelayAccount, type RelayEnrollment } from "../web/relay-login.js";
import { theme } from "./theme.js";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

function relayProblem(value: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return "中继地址无效，例如 https://relay.example.com";
  }
  if (parsed.protocol !== "https:" && !LOOPBACK.has(parsed.hostname)) {
    return "中继地址需使用 HTTPS；只有本机回环地址允许 HTTP";
  }
  return null;
}

/** Account login for `/relay login`; the password never enters the composer. */
export function RelayLoginDialog({ home, relayUrl, onClose, onSaved }: {
  home: string;
  relayUrl?: string;
  onClose(): void;
  onSaved(result: RelayEnrollment): void;
}): React.ReactElement {
  const initialRelay = relayUrl?.trim() ?? "";
  const initialProblem = initialRelay ? relayProblem(initialRelay) : null;
  const [relay, setRelay] = useState(initialRelay);
  const [step, setStep] = useState<"relay" | "email" | "password" | "busy" | "done">(initialRelay && !initialProblem ? "email" : "relay");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState(initialProblem ?? (initialRelay ? "请输入账户邮箱" : "请输入中继地址"));
  const [saved, setSaved] = useState<RelayEnrollment | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const submit = async (): Promise<void> => {
    if (step !== "password") return;
    if (!password) { setMessage("密码不能为空"); return; }
    setStep("busy");
    setMessage("正在登录并生成本机设备令牌…");
    try {
      const result = await loginRelayAccount({ home, relayUrl: relay, email, password, writeConfig: true });
      if (!alive.current) return;
      setPassword("");
      setSaved(result);
      setStep("done");
      setMessage("");
      onSaved(result);
    } catch (error) {
      if (!alive.current) return;
      setPassword("");
      setStep("password");
      setMessage(`登录失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === "c")) {
      if (step === "busy") return;
      onClose();
      return;
    }
    if (step === "busy") return;
    if (step === "done") { if (key.return) onClose(); return; }
    if (key.return) {
      if (step === "relay") {
        const value = relay.trim();
        const problem = value ? relayProblem(value) : "请输入中继地址，例如 https://relay.example.com";
        if (problem) { setMessage(problem); return; }
        setRelay(value);
        setStep("email");
        setMessage("中继已记录；请输入账户邮箱");
        return;
      }
      if (step === "email") {
        const value = email.trim();
        if (!EMAIL.test(value)) { setMessage("邮箱格式不正确，请检查后重试"); return; }
        setEmail(value);
        setStep("password");
        setMessage(`邮箱已记录：${value} · 请输入密码`);
        return;
      }
      void submit();
      return;
    }
    if (key.backspace || key.delete) {
      if (step === "relay") setRelay(current => current.slice(0, -1));
      else if (step === "email") setEmail(current => current.slice(0, -1));
      else if (step === "password") setPassword(current => current.slice(0, -1));
      return;
    }
    if (key.ctrl && input === "u") {
      if (step === "relay") setRelay("");
      else if (step === "email") setEmail("");
      else if (step === "password") setPassword("");
      return;
    }
    if (key.ctrl || key.meta || key.escape) return;
    const clean = input.replaceAll(/[\u0000-\u001f\u007f]/gu, "");
    if (!clean) return;
    if (step === "relay") setRelay(current => (current + clean.replaceAll(/\s/gu, "")).slice(0, 500));
    else if (step === "email") setEmail(current => (current + clean.replaceAll(/\s/gu, "")).slice(0, 320));
    else if (step === "password") setPassword(current => (current + clean).slice(0, 8192));
  });

  return <Box flexDirection="column" marginTop={1}>
    <Text bold color={theme.muted}>中继账户登录</Text>
    <Text color={theme.dim}>密码只用于本次请求，不写入项目、会话、输入历史或配置。</Text>
    <Text>中继：{relay || "（未填写）"}{step === "relay" ? "▏" : ""}</Text>
    {step === "email" || step === "password" || step === "busy" || step === "done"
      ? <Text>邮箱：{email || "（未填写）"}{step === "email" ? "▏" : ""}</Text> : null}
    {step === "password" || step === "busy" || step === "done"
      ? <Text>密码：{"•".repeat(Math.min(password.length, 32))}{step === "password" ? "▏" : ""}</Text> : null}
    {step === "relay" ? <Text color={theme.dim}>输入中继地址 · Enter 下一步 · Esc 取消</Text> : null}
    {step === "email" ? <Text color={theme.dim}>输入邮箱 · Enter 确认 · Ctrl+U 清空 · Esc 取消</Text> : null}
    {step === "password" ? <Text color={theme.dim}>输入密码（不回显）· Enter 登录 · Ctrl+U 清空 · Esc 取消</Text> : null}
    {step === "busy" ? <Text color={theme.yellow}>正在登录，请稍候…</Text> : null}
    {step === "done" && saved ? <Box flexDirection="column">
      <Text color={theme.green}>✓ 已登录 {saved.email}</Text>
      <Text color={theme.dim}>设备令牌已保存到 {saved.envPath}（权限 600）</Text>
      <Text color={theme.dim}>已更新 {saved.configPath}；重新启动 luban 后自动接入中继。</Text>
      <Text color={theme.yellow}>新令牌会替换账户原来的设备令牌；其他电脑需要重新登录或更新令牌。</Text>
      <Text color={theme.dim}>Enter 或 Esc 关闭</Text>
    </Box> : null}
    {message ? <Text color={theme.yellow}>{message}</Text> : null}
  </Box>;
}
