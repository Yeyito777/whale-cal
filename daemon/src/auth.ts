import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";

export interface Principal { id: string; name: string; admin: boolean }
export const LOCAL_OWNER: Principal = { id: "local", name: "Local owner", admin: true };

export class ApiError extends Error {
  constructor(message: string, readonly code: "unauthorized" | "forbidden" | "conflict" | "invalid" = "invalid") { super(message); }
}

export class Auth {
  constructor(private readonly sql: Database) {}

  authenticate(token: string): Principal {
    if (!token || token.length > 256) throw new ApiError("Authentication required.", "unauthorized");
    const row = this.sql.query(`SELECT users.id, users.name, users.admin FROM tokens JOIN users ON users.id=tokens.user_id WHERE tokens.hash=?`)
      .get(createHash("sha256").update(token).digest("hex")) as { id: string; name: string; admin: number } | null;
    if (!row) throw new ApiError("Invalid or revoked token.", "unauthorized");
    return { ...row, admin: row.admin === 1 };
  }

  users(): Principal[] {
    return (this.sql.query("SELECT id, name, admin FROM users ORDER BY rowid").all() as { id: string; name: string; admin: number }[])
      .map(row => ({ ...row, admin: row.admin === 1 }));
  }

  createUser(name: string): Principal {
    if (typeof name !== "string" || !name.trim() || name.length > 100) throw new ApiError("User name must be 1–100 characters.");
    if (this.users().some(user => user.name.toLowerCase() === name.trim().toLowerCase())) throw new ApiError("User name already exists.");
    const user = { id: randomUUID(), name: name.trim(), admin: false };
    this.sql.query("INSERT INTO users (id, name) VALUES (?, ?)").run(user.id, user.name);
    return user;
  }

  issueToken(userId: string, label: string): { token: string; tokenId: string } {
    if (!this.users().some(user => user.id === userId)) throw new ApiError("User not found.");
    if (typeof label !== "string" || !label.trim() || label.length > 100) throw new ApiError("Token label must be 1–100 characters.");
    const token = randomBytes(32).toString("base64url");
    const tokenId = createHash("sha256").update(token).digest("hex");
    this.sql.query("INSERT INTO tokens VALUES (?, ?, ?, ?)").run(tokenId, userId, label.trim(), new Date().toISOString());
    return { token, tokenId };
  }

  revokeToken(tokenId: string): void {
    this.sql.query("DELETE FROM tokens WHERE hash=?").run(tokenId);
  }

  tokens(): { tokenId: string; userId: string; label: string; createdAt: string }[] {
    return this.sql.query("SELECT hash AS tokenId, user_id AS userId, label, created_at AS createdAt FROM tokens ORDER BY created_at")
      .all() as { tokenId: string; userId: string; label: string; createdAt: string }[];
  }
}
