import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import { connect as connectTls } from "node:tls";

/**
 * Minimal SMTP sender for the registration code.
 *
 * The relay only needs one message type, so this talks SMTPS (implicit TLS,
 * port 465 — what 163/QQ mail use for app passwords) instead of pulling a mail
 * framework into the runtime. The password is an app password, never a mailbox
 * password, and it is only read from the service environment.
 */

export interface SmtpConfig {
  host: string;
  port: number;
  /** Authenticated mailbox, also used as the envelope sender. */
  from: string;
  password: string;
}

interface SmtpReply {
  code: number;
  text: string;
}

function encodeHeader(value: string): string {
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function message(config: SmtpConfig, to: string, code: string): string {
  const body = [
    "你好，",
    "",
    `你的 luban 注册验证码是：${code}`,
    "",
    "验证码 10 分钟内有效。如果不是你本人操作，请忽略这封邮件。",
    "",
    "— luban 中继",
  ].join("\r\n");
  return [
    `From: ${encodeHeader("luban 中继")} <${config.from}>`,
    `To: <${to}>`,
    `Subject: ${encodeHeader("luban 注册验证码")}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${randomBytes(12).toString("hex")}@luban.local>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(body, "utf8").toString("base64"),
  ].join("\r\n");
}

export async function sendVerificationEmail(config: SmtpConfig, to: string, code: string): Promise<void> {
  const socket = connectTls({
    host: config.host,
    port: config.port,
    servername: config.host,
    rejectUnauthorized: true,
  });
  socket.setTimeout(20_000, () => socket.destroy(new Error("SMTP 连接超时")));
  await new Promise<void>((resolve, reject) => {
    socket.once("secureConnect", resolve);
    socket.once("error", reject);
  });
  socket.setEncoding("utf8");
  const reader = createInterface({ input: socket, crlfDelay: Number.POSITIVE_INFINITY });
  const lines = reader[Symbol.asyncIterator]();

  const readLine = async (): Promise<string> => {
    const next = await lines.next();
    if (next.done) throw new Error("SMTP 连接提前关闭");
    return next.value;
  };
  const readReply = async (): Promise<SmtpReply> => {
    const first = await readLine();
    const code = Number(first.slice(0, 3));
    const parts = [first];
    let last = first;
    while (last.length > 3 && last[3] === "-") {
      last = await readLine();
      parts.push(last);
    }
    return { code, text: parts.join("\n") };
  };
  const expect = async (expected: number | number[], step: string): Promise<SmtpReply> => {
    const reply = await readReply();
    const allowed = Array.isArray(expected) ? expected : [expected];
    if (!allowed.includes(reply.code)) throw new Error(`${step} 失败：${reply.text.slice(0, 300)}`);
    return reply;
  };
  const command = async (line: string, expected: number | number[], step: string): Promise<SmtpReply> => {
    socket.write(`${line}\r\n`);
    const reply = await readReply();
    const allowed = Array.isArray(expected) ? expected : [expected];
    if (!allowed.includes(reply.code)) throw new Error(`${step} 失败：${reply.text.slice(0, 300)}`);
    return reply;
  };

  try {
    await expect(220, "连接");
    await command("EHLO luban-relay", 250, "EHLO");
    await command("AUTH LOGIN", 334, "AUTH LOGIN");
    await command(Buffer.from(config.from, "utf8").toString("base64"), 334, "AUTH 邮箱");
    await command(Buffer.from(config.password, "utf8").toString("base64"), 235, "登录");
    await command(`MAIL FROM:<${config.from}>`, 250, "MAIL FROM");
    await command(`RCPT TO:<${to}>`, [250, 251], "RCPT TO");
    await command("DATA", 354, "DATA");
    socket.write(`${message(config, to, code)}\r\n.\r\n`);
    await expect(250, "发送");
  } finally {
    try { socket.write("QUIT\r\n"); } catch { /* already closed */ }
    reader.close();
    socket.destroy();
  }
}

export function smtpFromEnv(env: NodeJS.ProcessEnv = process.env): SmtpConfig | undefined {
  const from = env.LUBAN_RELAY_SMTP_EMAIL?.trim();
  const password = env.LUBAN_RELAY_SMTP_PASSWORD?.trim();
  if (!from || !password) return undefined;
  const port = Number(env.LUBAN_RELAY_SMTP_PORT || 465);
  return {
    host: env.LUBAN_RELAY_SMTP_HOST?.trim() || "smtp.163.com",
    port: Number.isFinite(port) && port > 0 ? port : 465,
    from,
    password,
  };
}
