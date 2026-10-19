/* The page as an MCP Apps host (SPEC "MCP Apps view"). When a tool that links a ui:// view runs,
   the page reads the view through the server (resources/read via the relay), mounts it in a
   sandboxed iframe with the SDK's AppBridge (js/app-host.js, built from src/ui/host), and sends it
   each linked call's arguments and result. One view follows one transfer and updates in place; a
   new transfer, or one asked about after other cards, gets a new view. The view's own tool calls
   go to /sim/app-tool, so the browser never holds the Bearer secret. */

import { api } from "./api.js";

const VIEW_HEIGHT = 720;

/** Colours for the view (MCP Apps style variables), per simulator theme. */
const PALETTE = {
  blue: { accent: "#6fd6ff" },
  mono: { accent: "#ffffff" },
};

export function createAppHost({
  theme,
  onExchanges,
  onConfirmed,
  sendText,
  conversationId,
  fallback,
}) {
  let host = null; // the AppBridge glue, once loaded
  let failed = false;
  const views = [];

  function styles() {
    const accent = PALETTE[theme()]?.accent ?? PALETTE.blue.accent;
    return {
      variables: {
        // Transparent: the view sits on the page's own glass card.
        "--color-background-primary": "transparent",
        "--color-background-secondary": "rgba(255, 255, 255, 0.06)",
        "--color-text-primary": "#f3f6f8",
        "--color-text-secondary": "rgba(236, 242, 247, 0.76)",
        "--color-text-tertiary": "rgba(236, 242, 247, 0.58)",
        "--color-text-inverse": "#06080e",
        "--color-text-info": accent,
        "--color-text-success": "#8ff0c2",
        "--color-text-danger": "#ff8f8f",
        "--color-text-warning": "#ffc56b",
        "--color-border-primary": "rgba(255, 255, 255, 0.11)",
        "--color-ring-primary": accent,
        "--font-sans": 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
        "--font-mono": "ui-monospace, Menlo, Consolas, monospace",
        "--border-radius-lg": "16px",
        "--border-radius-sm": "10px",
      },
    };
  }

  function hostContext(box) {
    return {
      theme: "dark",
      styles: styles(),
      displayMode: "inline",
      availableDisplayModes: ["inline"],
      platform: "web",
      locale: navigator.language || "en",
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      containerDimensions: { maxHeight: VIEW_HEIGHT, width: box?.clientWidth || 560 },
    };
  }

  /** Loads the bridge once; without it (not built) the page keeps its own cards. */
  async function load() {
    if (host || failed) return host;
    try {
      host = await import("./app-host.js");
    } catch (err) {
      failed = true;
      console.warn("MCP Apps host unavailable; showing the page's own cards.", err);
    }
    return host;
  }

  /** Ids a call shares with the rest of its transfer: quote, confirmation token, reference. */
  function keysOf(call) {
    const sc = call.result?.structuredContent ?? {};
    const input = call.input ?? {};
    return [
      input.quote_id,
      sc.quote_id,
      input.confirmation_token,
      sc.confirmation_token,
      input.transfer_ref,
      sc.transfer_ref,
    ].filter((v) => typeof v === "string");
  }

  /** True when nothing but chat lines came after the view, so updating it in place is seen. */
  function stillInView(node) {
    for (let n = node.nextElementSibling; n; n = n.nextElementSibling) {
      if (n.classList.contains("card")) return false;
    }
    return true;
  }

  function newView(uri) {
    const node = document.createElement("article");
    node.className = "card appview rise";
    node.setAttribute("aria-label", "Transfer view, an MCP App from the server");
    const head = document.createElement("p");
    head.className = "appview-head";
    head.textContent = `MCP App · ${uri}`;
    const box = document.createElement("div");
    box.className = "appview-box";
    node.append(head, box);
    const v = {
      uri,
      node,
      box,
      keys: new Set(),
      mounted: null,
      chain: Promise.resolve(),
      lastStatus: new Map(),
    };
    views.push(v);

    v.chain = (async () => {
      const mod = await load();
      if (!mod) throw new Error("no host");
      const r = await api.appView(uri);
      onExchanges("App view · resources/read", r.exchanges);
      node.classList.toggle("bordered", r.prefers_border !== false);
      v.mounted = mod.mountView({
        parent: box,
        frameUrl: r.frame_url,
        title: "Nuvio Remit transfer view (MCP App)",
        hostContext: hostContext(box),
        callTool: (name, args) => callFromView(v, name, args),
        sendMessage: async (text) => {
          if (!sendText(text)) throw new Error("The assistant is busy.");
        },
        updateContext: async (text, structured) => {
          const c = conversationId();
          if (c) await api.appContext(c, text, structured);
        },
      });
    })();
    return v;
  }

  async function callFromView(v, name, args) {
    const r = await api.appTool(v.uri, name, args);
    const sc = r.result?.structuredContent ?? {};
    // A poll that changed nothing stays out of the protocol panel.
    const quiet =
      name === "track_transfer" &&
      sc.transfer_ref &&
      v.lastStatus.get(sc.transfer_ref) === sc.status;
    if (sc.transfer_ref) v.lastStatus.set(sc.transfer_ref, sc.status);
    if (!quiet) onExchanges(`App view · ${name}`, r.exchanges, { name, sc });
    if (name === "confirm_transfer" && sc.transfer_ref && !sc.refused) onConfirmed(sc);
    return r.result;
  }

  return {
    /** Whether linked calls should go to views (the bridge loaded) rather than cards. */
    get enabled() {
      return !failed;
    },
    preload: load,

    /**
     * Places one turn's linked calls ({ tc, x, sc } with tc.app). Returns the new view cards to
     * append, in order; the calls are delivered once each view has loaded.
     */
    place(paired) {
      const nodes = [];
      for (const p of paired) {
        const call = p.tc.app;
        const keys = keysOf(call);
        let v = views.at(-1);
        const reuse =
          v &&
          !v.dead &&
          v.uri === call.resource_uri &&
          keys.some((k) => v.keys.has(k)) &&
          stillInView(v.node);
        if (!reuse) {
          const prev = views.at(-1);
          if (prev && !prev.dead) {
            prev.dead = true;
            void prev.chain.then(() => prev.mounted?.teardown());
          }
          v = newView(call.resource_uri);
          nodes.push(v.node);
        }
        keys.forEach((k) => v.keys.add(k));
        const view = v;
        view.chain = view.chain
          .then(() => view.mounted.deliver(call.input, call.result))
          .catch(() => {
            // The view could not load: the page's own cards stand in, in the view's place.
            const cards = fallback([p]);
            if (!cards.length) return;
            if (view.anchor) view.anchor.after(...cards);
            else view.node.replaceWith(...cards);
            view.anchor = cards.at(-1);
          });
        if (p.sc?.transfer_ref) view.lastStatus.set(p.sc.transfer_ref, p.sc.status);
      }
      return nodes;
    },

    /** The theme changed: tell every live view. */
    retheme() {
      for (const v of views) if (!v.dead && v.mounted) v.mounted.setContext(hostContext(v.box));
    },

    /** Demo data reset: forget every view. */
    reset() {
      for (const v of views) {
        v.dead = true;
        void v.chain.then(() => v.mounted?.teardown()).catch(() => undefined);
      }
      views.length = 0;
    },
  };
}
