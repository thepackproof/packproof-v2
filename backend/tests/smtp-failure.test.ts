import { Duplex } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const { connect } = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock("node:tls", () => ({ connect }));
import { SmtpEmailDelivery } from "../src/integrations/email/delivery.js";

class FakeSocket extends Duplex {
  setTimeout = vi.fn();
  _read() {}
  _write(_chunk: Buffer, _encoding: string, callback: (error?: Error | null) => void) { callback(); }
}

afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });
describe("SMTP failure containment", () => {
  function setup() {
    const socket = new FakeSocket();
    connect.mockReturnValue(socket);
    const delivery = new SmtpEmailDelivery({ host: "smtp.test", port: 465, username: "user", password: "secret", from: "proofs@example.com" });
    const pending = delivery.send({ to: "buyer@example.com", subject: "Proof", text: "Proof", html: "<p>Proof</p>" });
    return { socket, pending };
  }
  it("rejects and cleans up on a socket failure after the TLS handshake", async () => {
    const { socket, pending } = setup();
    const checked = expect(pending).rejects.toThrow("connection lost");
    socket.emit("secureConnect");
    await Promise.resolve();
    socket.destroy(new Error("connection lost"));
    await checked;
    expect(socket.destroyed).toBe(true);
  });
  it("bounds the complete delivery even if a peer never finishes its reply", async () => {
    vi.useFakeTimers();
    const { socket, pending } = setup();
    const checked = expect(pending).rejects.toThrow("SMTP delivery timed out");
    socket.emit("secureConnect");
    await vi.advanceTimersByTimeAsync(60_001);
    await checked;
    expect(socket.destroyed).toBe(true);
  });
});
