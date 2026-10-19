import { createHash, timingSafeEqual } from "node:crypto";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { Request, RequestHandler } from "express";
import { DEMO_USER_ID } from "../core/policy.js";

const digest = (s: string) => createHash("sha256").update(s).digest();

/** Who is calling: the user whose ledger the tools act on, and the key tokens are bound to. */
export interface Principal {
  userId: string;
  callerId: string;
}

/**
 * Requires `Authorization: Bearer <token>`. On failure returns 401 with a JSON-RPC error body and
 * deliberately no WWW-Authenticate header: there is no OAuth flow for clients to discover.
 * Never logs the presented or expected token.
 *
 * On success sets `req.auth`, which the MCP SDK hands to every tool as `extra.authInfo`. The demo
 * has one user behind one Bearer secret; production would map an OAuth subject + client here. The
 * caller id includes a hash of the credential, so rotating the secret voids outstanding tokens.
 */
export function bearerAuth(expectedToken: string): RequestHandler {
  const expected = digest(expectedToken);
  const principal: Principal = {
    userId: DEMO_USER_ID,
    callerId: `${DEMO_USER_ID}:${expected.toString("hex").slice(0, 16)}`,
  };
  return (req, res, next) => {
    const header = req.get("authorization") ?? "";
    const match = /^Bearer\s+(.+)$/i.exec(header);
    // Compare fixed-length digests so timing does not leak the token or its length.
    if (match?.[1] && timingSafeEqual(digest(match[1].trim()), expected)) {
      (req as Request & { auth?: AuthInfo }).auth = {
        token: match[1].trim(),
        clientId: "nuvio-remit-demo",
        scopes: [],
        extra: { ...principal },
      };
      next();
      return;
    }
    console.warn(`auth: rejected ${req.method} ${req.path} (${header ? "bad token" : "no token"})`);
    res.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Unauthorized: missing or invalid bearer token" },
      id: null,
    });
  };
}

/** The principal from a tool call's authInfo; throws (-> INTERNAL_ERROR) if auth was bypassed. */
export function principalOf(authInfo: AuthInfo | undefined): Principal {
  const extra = authInfo?.extra as Partial<Principal> | undefined;
  if (!extra?.userId || !extra.callerId) throw new Error("missing principal");
  return { userId: extra.userId, callerId: extra.callerId };
}
