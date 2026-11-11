import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  SessionVault,
  VaultError,
} from "../../../src/security/sessionVault.js";
import type { SessionState } from "../../../src/core/types.js";

function session(): SessionState {
  return {
    tokens: {
      accessToken: "access-token-value-that-must-not-leak",
      refreshToken: "refresh-token-value-that-must-not-leak",
      tokenType: "Bearer",
      expiresAt: 1_900_000_000_000,
    },
    deviceId: "device-abc-123",
    lastRefreshedAt: 1_800_000_000_000,
  };
}

function mutateBase64Url(value: string): string {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const first = value.at(0) ?? "A";
  const replacement = alphabet[(alphabet.indexOf(first) + 1) % alphabet.length];
  return `${replacement}${value.slice(1)}`;
}

describe("SessionVault raw key mode", () => {
  it("round-trips tokens and device id", () => {
    const vault = SessionVault.fromKey(randomBytes(32));
    const original = session();

    const envelope = vault.seal(original);
    expect(vault.open(envelope)).toEqual(original);
  });

  it("uses a fresh IV so identical sessions produce different envelopes", () => {
    const vault = SessionVault.fromKey(randomBytes(32));
    const original = session();

    const first = vault.seal(original);
    const second = vault.seal(original);

    expect(first).not.toBe(second);
    expect(vault.open(first)).toEqual(original);
    expect(vault.open(second)).toEqual(original);
  });

  it("rejects a key that is not exactly 32 bytes", () => {
    expect(() => SessionVault.fromKey(new Uint8Array(31))).toThrow(VaultError);
    expect(() => SessionVault.fromKey(new Uint8Array(33))).toThrow(VaultError);
  });

  it("cannot decrypt with a different key", () => {
    const envelope = SessionVault.fromKey(randomBytes(32)).seal(session());
    const other = SessionVault.fromKey(randomBytes(32));

    expect(() => other.open(envelope)).toThrowError(
      expect.objectContaining({ code: "DECRYPT_FAILED" }),
    );
  });

  it("binds the optional context as AAD", () => {
    const vault = SessionVault.fromKey(randomBytes(32), { context: "prod" });
    const envelope = vault.seal(session());

    expect(() => vault.open(envelope, "staging")).toThrow(VaultError);
    expect(vault.open(envelope, "prod")).toEqual(session());
  });

  it("rejects tampered ciphertext and tag", () => {
    const vault = SessionVault.fromKey(randomBytes(32));
    const parts = vault.seal(session()).split(".");

    const tamperedCiphertext = [...parts];
    tamperedCiphertext[5] = mutateBase64Url(parts[5]!);
    expect(() => vault.open(tamperedCiphertext.join("."))).toThrowError(
      expect.objectContaining({ code: "DECRYPT_FAILED" }),
    );

    const tamperedTag = [...parts];
    tamperedTag[4] = mutateBase64Url(parts[4]!);
    expect(() => vault.open(tamperedTag.join("."))).toThrowError(
      expect.objectContaining({ code: "DECRYPT_FAILED" }),
    );
  });

  it("rejects malformed envelopes", () => {
    const vault = SessionVault.fromKey(randomBytes(32));
    for (const envelope of [
      "",
      "not-an-envelope",
      "mv2.raw..aaaa.bbbb.cccc",
      "mv1.raw..notbase64!.bbbb.cccc",
      "mv1.scrypt..aaaa.bbbb.cccc",
    ]) {
      expect(() => vault.open(envelope)).toThrow(VaultError);
    }
  });

  it("validates session shape before sealing", () => {
    const vault = SessionVault.fromKey(randomBytes(32));
    expect(() =>
      vault.seal({
        tokens: { accessToken: "", refreshToken: "r", tokenType: "Bearer" },
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_SESSION" }));
  });

  it("never includes tokens or key material in errors", () => {
    const vault = SessionVault.fromKey(randomBytes(32));
    const original = session();
    const envelope = vault.seal(original);
    const wrong = SessionVault.fromKey(randomBytes(32));

    try {
      wrong.open(envelope);
      throw new Error("expected open to fail");
    } catch (error) {
      const text = `${String(error)} ${JSON.stringify(error)}`;
      expect(text).not.toContain(original.tokens.accessToken);
      expect(text).not.toContain(original.tokens.refreshToken);
      expect(text).not.toContain(original.deviceId);
      expect(text).not.toContain(envelope);
    }
  });
});

describe("SessionVault passphrase mode", () => {
  it("round-trips with a passphrase and a random salt", () => {
    const vault = SessionVault.fromPassphrase("correct horse battery staple");
    const original = session();

    expect(vault.open(vault.seal(original))).toEqual(original);
  });

  it("can open an envelope from an earlier vault instance", () => {
    const first = SessionVault.fromPassphrase("correct horse battery staple");
    const envelope = first.seal(session());
    // A new instance generates a different salt for future seals but can still
    // derive the salt carried by the old envelope.
    const second = SessionVault.fromPassphrase("correct horse battery staple");

    expect(second.open(envelope)).toEqual(session());
    expect(second.seal(session())).not.toBe(envelope);
  });

  it("rejects a short passphrase", () => {
    expect(() => SessionVault.fromPassphrase("short")).toThrowError(
      expect.objectContaining({ code: "INVALID_PASSPHRASE" }),
    );
  });

  it("cannot be opened by a raw-key vault or a different passphrase", () => {
    const envelope = SessionVault.fromPassphrase(
      "correct horse battery staple",
    ).seal(session());

    expect(() => SessionVault.fromKey(randomBytes(32)).open(envelope)).toThrow(
      VaultError,
    );
    expect(() =>
      SessionVault.fromPassphrase("a completely different passphrase").open(
        envelope,
      ),
    ).toThrowError(expect.objectContaining({ code: "DECRYPT_FAILED" }));
  });
});
