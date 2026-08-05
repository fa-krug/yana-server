import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendMailMock = vi.fn();
const createTransportMock = vi.fn(() => ({ sendMail: sendMailMock }));

vi.mock("nodemailer", () => ({
  default: { createTransport: createTransportMock },
}));

describe("src/lib/email/client", () => {
  let client: typeof import("./client");

  beforeEach(async () => {
    vi.resetModules();
    createTransportMock.mockClear();
    sendMailMock.mockClear();
    delete process.env.SMTP_HOST;
    delete process.env.SMTP_PORT;
    delete process.env.SMTP_SECURE;
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASSWORD;
    delete process.env.EMAIL_FROM;
    client = await import("./client");
  });

  it("logs and does not construct a transport when SMTP_HOST is unset", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await client.sendMail("a@example.com", "subject", "body");

    expect(createTransportMock).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("a@example.com"));
    logSpy.mockRestore();
  });

  it("sends through the configured transport when SMTP_HOST is set", async () => {
    process.env.SMTP_HOST = "smtp.example.com";
    process.env.SMTP_PORT = "465";
    process.env.SMTP_SECURE = "true";
    process.env.SMTP_USER = "user";
    process.env.SMTP_PASSWORD = "pass";
    process.env.EMAIL_FROM = "yana@example.com";

    await client.sendMail("a@example.com", "subject", "body");

    expect(createTransportMock).toHaveBeenCalledWith({
      host: "smtp.example.com",
      port: 465,
      secure: true,
      auth: { user: "user", pass: "pass" },
    });
    expect(sendMailMock).toHaveBeenCalledWith({
      from: "yana@example.com",
      to: "a@example.com",
      subject: "subject",
      text: "body",
    });
  });

  it("catches and logs a rejected send instead of throwing", async () => {
    process.env.SMTP_HOST = "smtp.example.com";
    sendMailMock.mockRejectedValueOnce(new Error("connection refused"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(client.sendMail("a@example.com", "s", "b")).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("failed to send to a@example.com"),
      expect.any(Error),
    );
    errorSpy.mockRestore();
  });
});
