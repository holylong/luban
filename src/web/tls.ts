import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * TLS material for the relay.
 *
 * A phone only treats the console as a secure context — and therefore offers
 * "Add to Home screen" — when the certificate is trusted by the device. So this
 * generates a small CA plus a leaf certificate whose Subject Alternative Names
 * cover the LAN address the phone will dial. Installing `ca.pem` on the phone
 * once makes every address in that set trusted; without it Chrome shows the
 * full-screen warning and hides the install entry.
 */

export interface TlsMaterial {
  key: string;
  cert: string;
  /** CA certificate to install on the phone so the leaf is trusted. */
  ca: string;
}

export interface GenerateOptions {
  /** Hosts (IPs or names) the certificate must be valid for. */
  hosts: string[];
  /** Directory to persist key/cert/ca; reused when they already exist. */
  dir?: string;
  /** Override the openssl binary, for tests or non-standard installs. */
  opensslPath?: string;
}

const VALID_DAYS = 825; // Chrome's ceiling for locally-trusted certs is 398 days; 825 is the X.509 convention.

/**
 * Produce (or reuse) a self-signed CA and a leaf certificate for `hosts`.
 * Reuses an existing bundle in `dir` so repeated `--https` starts keep one CA
 * and the phone does not have to re-trust it after every restart.
 */
export function generateTlsMaterial(options: GenerateOptions): TlsMaterial {
  const openssl = options.opensslPath || "openssl";
  const dir = options.dir || join(tmpdir(), "luban-relay-tls");
  const keyPath = join(dir, "key.pem");
  const certPath = join(dir, "cert.pem");
  const caPath = join(dir, "ca.pem");
  if (existsSync(keyPath) && existsSync(certPath) && existsSync(caPath) && certCovers(certPath, options.hosts)) {
    return { key: readFileSync(keyPath, "utf8"), cert: readFileSync(certPath, "utf8"), ca: readFileSync(caPath, "utf8") };
  }

  mkdirSync(dir, { recursive: true });
  const san = options.hosts
    .map((host) => (isIpv4(host) || isIpv6(host) ? `IP:${host}` : `DNS:${host}`))
    .join(",");
  // One openssl invocation: a self-signed cert that is its own CA (basicConstraints
  // CA:true) and carries the SANs. A single file is both the trust anchor and the
  // leaf, which is all a LAN test needs and keeps the phone setup to one install.
  const result = spawnSync(openssl, [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", keyPath, "-out", certPath,
    "-days", String(VALID_DAYS),
    "-subj", "/O=luban/CN=luban relay",
    "-addext", `basicConstraints=critical,CA:true`,
    "-addext", `keyUsage=critical,digitalSignature,keyEncipherment,keyCertSign`,
    "-addext", `extendedKeyUsage=serverAuth`,
    "-addext", `subjectAltName=${san}`,
  ], { encoding: "utf8" });
  if (result.status !== 0) {
    const detail = (result.stderr || result.error?.message || "").trim();
    throw new Error(`could not generate a certificate (openssl ${detail || "not found"}). Provide --tls-key and --tls-cert instead, or run the relay behind Tailscale.`);
  }
  // The cert is its own CA, so ca.pem is a copy of cert.pem.
  writeFileSync(caPath, readFileSync(certPath));
  return { key: readFileSync(keyPath, "utf8"), cert: readFileSync(certPath, "utf8"), ca: readFileSync(caPath, "utf8") };
}

/** Read a user-supplied key + cert pair. */
export function readTlsMaterial(keyPath: string, certPath: string): TlsMaterial {
  return { key: readFileSync(keyPath, "utf8"), cert: readFileSync(certPath, "utf8"), ca: readFileSync(certPath, "utf8") };
}

function isIpv4(host: string): boolean {
  return /^[0-9]{1,3}(\.[0-9]{1,3}){3}$/.test(host);
}

function isIpv6(host: string): boolean {
  return host.includes(":") && /^[0-9a-fA-F:]+$/.test(host);
}

/** True when an existing cert already lists every host we need. */
function certCovers(certPath: string, hosts: string[]): boolean {
  try {
    const probe = spawnSync("openssl", ["x509", "-in", certPath, "-noout", "-ext", "subjectAltName"], { encoding: "utf8" });
    if (probe.status !== 0) return false;
    const text = probe.stdout || "";
    return hosts.every((host) => text.includes(host));
  } catch {
    return false;
  }
}
