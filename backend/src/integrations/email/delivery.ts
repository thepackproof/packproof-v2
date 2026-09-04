import { once } from "node:events";
import { createInterface } from "node:readline";
import * as tls from "node:tls";

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface EmailDelivery {
  readonly enabled: boolean;
  send(message: EmailMessage): Promise<void>;
}

export class DisabledEmailDelivery implements EmailDelivery {
  readonly enabled = false;
  async send(): Promise<void> {
    throw new Error("Email delivery is not configured");
  }
}

export interface SmtpEmailConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  from: string;
  heloName?: string;
}

/**
 * Minimal SMTP-over-TLS transport. Port 465 is the intended production mode
 * and works with AWS SES SMTP credentials as well as other standard providers.
 * No email provider secret is ever included in Proof data or audit events.
 */
export class SmtpEmailDelivery implements EmailDelivery {
  readonly enabled = true;

  constructor(private readonly config: SmtpEmailConfig) {}

  async send(message: EmailMessage): Promise<void> {
    const socket = tls.connect({
      host: this.config.host,
      port: this.config.port,
      servername: this.config.host,
      rejectUnauthorized: true,
    });
    socket.setTimeout(15_000, () => socket.destroy(new Error("SMTP connection timed out")));
    await once(socket, "secureConnect");

    const lines = createInterface({ input: socket, crlfDelay: Infinity });
    const iterator = lines[Symbol.asyncIterator]();
    const readReply = async (expected: number): Promise<void> => {
      while (true) {
        const next = await iterator.next();
        if (next.done) throw new Error("SMTP connection closed unexpectedly");
        const line = String(next.value);
        const match = /^(\d{3})([- ])/.exec(line);
        if (!match) continue;
        const code = Number(match[1]);
        if (match[2] === "-") continue;
        if (code !== expected) throw new Error(`SMTP command failed with ${code}`);
        return;
      }
    };
    const command = async (value: string, expected: number) => {
      socket.write(`${value}\r\n`);
      await readReply(expected);
    };

    try {
      await readReply(220);
      await command(`EHLO ${sanitizeHeader(this.config.heloName || "thepackproof.com")}`, 250);
      await command("AUTH LOGIN", 334);
      await command(Buffer.from(this.config.username).toString("base64"), 334);
      await command(Buffer.from(this.config.password).toString("base64"), 235);
      await command(`MAIL FROM:<${sanitizeAddress(this.config.from)}>`, 250);
      await command(`RCPT TO:<${sanitizeAddress(message.to)}>`, 250);
      await command("DATA", 354);
      socket.write(`${formatMimeMessage(this.config.from, message)}\r\n.\r\n`);
      await readReply(250);
      socket.write("QUIT\r\n");
    } finally {
      lines.close();
      socket.end();
    }
  }
}

export function createEmailDeliveryFromEnv(env: NodeJS.ProcessEnv): EmailDelivery {
  const host = env.PACKPROOF_SMTP_HOST?.trim();
  const username = env.PACKPROOF_SMTP_USERNAME?.trim();
  const password = env.PACKPROOF_SMTP_PASSWORD;
  const from = env.PACKPROOF_EMAIL_FROM?.trim();
  if (!host || !username || !password || !from) {
    return new DisabledEmailDelivery();
  }
  const parsedPort = Number(env.PACKPROOF_SMTP_PORT || "465");
  if (!Number.isInteger(parsedPort) || parsedPort <= 0 || parsedPort > 65535) {
    throw new Error("PACKPROOF_SMTP_PORT must be a valid TCP port");
  }
  return new SmtpEmailDelivery({
    host,
    port: parsedPort,
    username,
    password,
    from,
    heloName: env.PACKPROOF_SMTP_HELO?.trim() || "thepackproof.com",
  });
}

function formatMimeMessage(from: string, message: EmailMessage): string {
  const boundary = `packproof-${Date.now().toString(36)}`;
  const headers = [
    `From: PackProof <${sanitizeAddress(from)}>`,
    `To: <${sanitizeAddress(message.to)}>`,
    `Subject: ${sanitizeHeader(message.subject)}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary=\"${boundary}\"`,
  ];
  const text = dotStuff(message.text);
  const html = dotStuff(message.html);
  return [
    ...headers,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    text,
    `--${boundary}`,
    "Content-Type: text/html; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    html,
    `--${boundary}--`,
  ].join("\r\n");
}

function sanitizeHeader(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function sanitizeAddress(value: string): string {
  const clean = sanitizeHeader(value);
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(clean)) {
    throw new Error("Invalid email address");
  }
  return clean;
}

function dotStuff(value: string): string {
  return value.replace(/(^|\r?\n)\./g, "$1..");
}
