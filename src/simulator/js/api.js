/* Talks to this server's /sim/* and /dev/* routes. The page never holds the MCP Bearer secret:
   the server-side relay makes the real POST /mcp calls and returns the exchanges. */

const SIM_KEY = "nuvio.simCode";
const DEV_KEY = "nuvio.devCode";

const store = {
  get(k) {
    try {
      return sessionStorage.getItem(k) || "";
    } catch {
      return "";
    }
  },
  set(k, v) {
    try {
      v ? sessionStorage.setItem(k, v) : sessionStorage.removeItem(k);
    } catch {
      /* private mode */
    }
  },
};

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.message || `HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

async function call(path, { method = "GET", body, dev = false, devToo = false } = {}) {
  const headers = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (dev) headers["x-dev-code"] = store.get(DEV_KEY);
  else headers["x-sim-code"] = store.get(SIM_KEY);
  // With the dev code entered (?dev=1), chat skips the per-IP limit for long test sessions.
  if (devToo && store.get(DEV_KEY)) headers["x-dev-code"] = store.get(DEV_KEY);
  const res = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON error page */
  }
  if (!res.ok) throw new ApiError(res.status, json);
  return json;
}

export const api = {
  get simCode() {
    return store.get(SIM_KEY);
  },
  set simCode(v) {
    store.set(SIM_KEY, v);
  },
  get devCode() {
    return store.get(DEV_KEY);
  },
  set devCode(v) {
    store.set(DEV_KEY, v);
  },

  tools: () => call("/sim/tools"),
  chat: (text, conversationId) =>
    call("/sim/chat", {
      method: "POST",
      devToo: true,
      body: { text, ...(conversationId ? { conversation_id: conversationId } : {}) },
    }),
  state: (since) => call(`/sim/state?since=${encodeURIComponent(since)}`),
  speak: (text) => call("/sim/speak", { method: "POST", body: { text }, devToo: true }),

  // MCP Apps host (SPEC "MCP Apps view"): read a view, a view's tools/call, a view's context update.
  appView: (uri) => call("/sim/app-view", { method: "POST", body: { uri } }),
  appTool: (resourceUri, name, args) =>
    call("/sim/app-tool", {
      method: "POST",
      body: { resource_uri: resourceUri, name, arguments: args ?? {} },
    }),
  appContext: (conversationId, text, structured) =>
    call("/sim/app-context", {
      method: "POST",
      body: { conversation_id: conversationId, text, ...(structured ? { structured } : {}) },
    }),

  dev: (action, body = {}) => call(`/dev/${action}`, { method: "POST", body, dev: true }),
};
