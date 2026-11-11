import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";
import type { SessionState, TokenSet } from "../core/types.js";

/**
 * AES-256-GCM session vault for access tokens, refresh tokens, and the stable
 * device id.
 *
 * This is an optional Node-only module published as `merchantid/vault`, so the
 * main entry stays free of Node builtins. It performs authenticated encryption
 * only: it does not decide where the ciphertext lives, and it never logs or
 * includes secrets in error messages.
 *
 * Envelope format (base64url, no padding):
 *
 * ```
 * mv1.<raw|scrypt>.<salt>.<iv>.<tag>.<ciphertext>
 * ```
 *
 * - raw mode: the caller supplies a 32-byte key.
 * - scrypt mode: a passphrase is stretched with scrypt (N=16384, r=8, p=1)
 *   and a 16-byte random salt. The salt travels in the envelope so old
 *   envelopes remain decryptable after a restart.
 * - AAD binds the envelope header and an optional caller context.
 */

const ENVELOPE_PREFIX = "mv1";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const SALT_BYTES = 16;
const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

export type VaultErrorCode =
  | "INVALID_KEY"
  | "INVALID_PASSPHRASE"
  | "INVALID_ENVELOPE"
  | "DECRYPT_FAILED"
  | "INVALID_SESSION";

/** Generic vault failure. Messages never contain key material or ciphertext. */
export class VaultError extends Error {
  public readonly code: VaultErrorCode;

  constructor(code: VaultErrorCode, message: string) {
    super(message);
    this.name = "VaultError";
    this.code = code;
  }
}

function toBase64Url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function fromBase64Url(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) {
    throw new VaultError(
      "INVALID_ENVELOPE",
      "Session vault envelope is malformed",
    );
  }
  return Buffer.from(value, "base64url");
}

function validateSession(value: unknown): SessionState {
  if (typeof value !== "object" || value === null) {
    throw new VaultError(
      "INVALID_SESSION",
      "Decrypted session is not an object",
    );
  }
  const candidate = value as Record<string, unknown>;
  const tokens = candidate.tokens;
  if (typeof tokens !== "object" || tokens === null) {
    throw new VaultError("INVALID_SESSION", "Decrypted session has no tokens");
  }
  const tokenRecord = tokens as Record<string, unknown>;
  const accessToken = tokenRecord.accessToken;
  const refreshToken = tokenRecord.refreshToken;
  const tokenType = tokenRecord.tokenType;
  if (
    typeof accessToken !== "string" ||
    accessToken.length === 0 ||
    typeof refreshToken !== "string" ||
    refreshToken.length === 0 ||
    typeof tokenType !== "string" ||
    tokenType.length === 0
  ) {
    throw new VaultError(
      "INVALID_SESSION",
      "Decrypted session tokens are incomplete",
    );
  }

  const expiresAt = tokenRecord.expiresAt;
  if (
    expiresAt !== undefined &&
    (typeof expiresAt !== "number" || !Number.isFinite(expiresAt))
  ) {
    throw new VaultError(
      "INVALID_SESSION",
      "Decrypted token expiry is invalid",
    );
  }

  const deviceId = candidate.deviceId;
  if (deviceId !== undefined && typeof deviceId !== "string") {
    throw new VaultError("INVALID_SESSION", "Decrypted device id is invalid");
  }
  const lastRefreshedAt = candidate.lastRefreshedAt;
  if (
    lastRefreshedAt !== undefined &&
    (typeof lastRefreshedAt !== "number" || !Number.isFinite(lastRefreshedAt))
  ) {
    throw new VaultError(
      "INVALID_SESSION",
      "Decrypted refresh timestamp is invalid",
    );
  }

  const normalizedTokens: TokenSet = {
    accessToken,
    refreshToken,
    tokenType,
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  };
  return {
    tokens: normalizedTokens,
    ...(deviceId !== undefined ? { deviceId } : {}),
    ...(lastRefreshedAt !== undefined ? { lastRefreshedAt } : {}),
  };
}

export class SessionVault {
  private readonly key: Buffer;
  private readonly salt: Buffer;
  private readonly context?: string;
  private readonly kdf: "raw" | "scrypt";
  /** Retained only for passphrase mode; required to derive per-envelope salts. */
  private readonly passphrase?: string;

  private constructor(
    key: Buffer,
    salt: Buffer,
    kdf: "raw" | "scrypt",
    context?: string,
    passphrase?: string,
  ) {
    this.key = key;
    this.salt = salt;
    this.kdf = kdf;
    this.context = context;
    this.passphrase = passphrase;
  }

  /**
   * Create a vault from a 32-byte AES key.
   *
   * Keep the key outside the database that stores envelopes: an attacker who
   * reads both can decrypt every session.
   */
  static fromKey(
    key: Uint8Array,
    options: { context?: string } = {},
  ): SessionVault {
    if (!(key instanceof Uint8Array) || key.length !== KEY_BYTES) {
      throw new VaultError(
        "INVALID_KEY",
        `Session vault key must be ${KEY_BYTES} bytes`,
      );
    }
    return new SessionVault(
      Buffer.from(key),
      Buffer.alloc(0),
      "raw",
      options.context,
    );
  }

  /**
   * Create a vault from a passphrase. The salt is random unless supplied; the
   * envelope carries it, so `open` can decrypt envelopes sealed by an earlier
   * process as long as the passphrase is the same.
   */
  static fromPassphrase(
    passphrase: string,
    options: { salt?: Uint8Array; context?: string } = {},
  ): SessionVault {
    if (typeof passphrase !== "string" || passphrase.length < 12) {
      throw new VaultError(
        "INVALID_PASSPHRASE",
        "Session vault passphrase must be at least 12 characters",
      );
    }
    if (
      options.salt !== undefined &&
      (!(options.salt instanceof Uint8Array) ||
        options.salt.length !== SALT_BYTES)
    ) {
      throw new VaultError(
        "INVALID_KEY",
        `Session vault salt must be ${SALT_BYTES} bytes`,
      );
    }
    const salt = options.salt
      ? Buffer.from(options.salt)
      : randomBytes(SALT_BYTES);
    return new SessionVault(
      deriveKey(passphrase, salt),
      salt,
      "scrypt",
      options.context,
      passphrase,
    );
  }

  /**
   * Encrypt a session into a self-contained envelope. A fresh random IV is
   * used for every call, so sealing the same session twice yields different
   * ciphertext.
   */
  seal(session: SessionState, context?: string): string {
    const validated = validateSession(session);
    const aadContext = context ?? this.context;
    const iv = randomBytes(IV_BYTES);
    const salt = this.kdf === "scrypt" ? this.salt : Buffer.alloc(0);
    const header = `${ENVELOPE_PREFIX}.${this.kdf}.${toBase64Url(salt)}`;
    const plaintext = Buffer.from(JSON.stringify(validated), "utf8");

    const cipher = createCipheriv("aes-256-gcm", this.key, iv, {
      authTagLength: TAG_BYTES,
    });
    cipher.setAAD(headerBytes(header, aadContext));
    const ciphertext = Buffer.concat([
      cipher.update(plaintext),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();

    return [
      header,
      toBase64Url(iv),
      toBase64Url(tag),
      toBase64Url(ciphertext),
    ].join(".");
  }

  /**
   * Decrypt and validate a session envelope.
   *
   * Every cryptographic/parsing failure becomes the same `DECRYPT_FAILED`
   * error, so callers cannot use error behavior as an oracle and error logs do
   * not reveal envelope contents.
   */
  open(envelope: string, context?: string): SessionState {
    if (typeof envelope !== "string" || envelope.length === 0) {
      throw new VaultError(
        "INVALID_ENVELOPE",
        "Session vault envelope is empty",
      );
    }

    const parts = envelope.split(".");
    if (parts.length !== 6 || parts[0] !== ENVELOPE_PREFIX) {
      throw new VaultError(
        "INVALID_ENVELOPE",
        "Session vault envelope is malformed",
      );
    }
    const [, kdf, saltPart, ivPart, tagPart, ciphertextPart] = parts;
    if (kdf !== "raw" && kdf !== "scrypt") {
      throw new VaultError(
        "INVALID_ENVELOPE",
        "Session vault envelope is malformed",
      );
    }
    if (kdf !== this.kdf) {
      throw new VaultError("DECRYPT_FAILED", "Unable to decrypt session vault");
    }

    let header: string;
    let key: Buffer;
    let iv: Buffer;
    let tag: Buffer;
    let ciphertext: Buffer;
    try {
      const salt = fromBase64Url(saltPart ?? "");
      iv = fromBase64Url(ivPart ?? "");
      tag = fromBase64Url(tagPart ?? "");
      ciphertext = fromBase64Url(ciphertextPart ?? "");
      if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
        throw new VaultError(
          "INVALID_ENVELOPE",
          "Session vault envelope is malformed",
        );
      }
      if (kdf === "scrypt") {
        if (salt.length !== SALT_BYTES) {
          throw new VaultError(
            "INVALID_ENVELOPE",
            "Session vault envelope is malformed",
          );
        }
        if (this.passphrase === undefined) {
          throw new VaultError(
            "INVALID_ENVELOPE",
            "Session vault was not initialized with a passphrase",
          );
        }
        key = deriveKey(this.passphrase, salt);
      } else {
        if (salt.length !== 0) {
          throw new VaultError(
            "INVALID_ENVELOPE",
            "Session vault envelope is malformed",
          );
        }
        key = this.key;
      }
      header = `${ENVELOPE_PREFIX}.${kdf}.${toBase64Url(salt)}`;
    } catch (error) {
      if (error instanceof VaultError) throw error;
      throw new VaultError(
        "INVALID_ENVELOPE",
        "Session vault envelope is malformed",
      );
    }

    try {
      const decipher = createDecipheriv("aes-256-gcm", key, iv, {
        authTagLength: TAG_BYTES,
      });
      decipher.setAAD(headerBytes(header, context ?? this.context));
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]);
      return validateSession(JSON.parse(plaintext.toString("utf8")));
    } catch (error) {
      if (error instanceof VaultError) throw error;
      throw new VaultError("DECRYPT_FAILED", "Unable to decrypt session vault");
    }
  }
}

function headerBytes(header: string, context?: string): Buffer {
  return Buffer.from(
    context === undefined ? header : `${header}|${context}`,
    "utf8",
  );
}

function deriveKey(passphrase: string, salt: Uint8Array): Buffer {
  return Buffer.from(
    scryptSync(passphrase, salt, KEY_BYTES, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
      maxmem: SCRYPT_MAXMEM,
    }),
  );
}
