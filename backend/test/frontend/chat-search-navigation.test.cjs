const assert = require("node:assert/strict");
const { test } = require("node:test");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const React = require("react");
const { createRoot } = require("react-dom/client");
const { JSDOM } = require("jsdom");

// Exercise the real hooks/components with controlled network responses.
function loadSource(path, mocks = {}) {
  const filename = resolve(__dirname, "../../../frontend/src", path);
  const code = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
  }).outputText;
  const module = { exports: {} };
  vm.runInThisContext(`(function(require,module,exports){${code}\n})`, {
    filename,
  })(
    (name) => (Object.hasOwn(mocks, name) ? mocks[name] : require(name)),
    module,
    module.exports,
  );
  return module.exports;
}
function setup() {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  global.window = dom.window;
  global.document = dom.window.document;
  global.CustomEvent = dom.window.CustomEvent;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  global.requestAnimationFrame = (fn) =>
    setImmediate(() => fn(performance.now()));
  global.cancelAnimationFrame = clearImmediate;
  const root = createRoot(document.getElementById("root"));
  return {
    root,
    async cleanup() {
      await React.act(() => root.unmount());
      dom.window.close();
      delete global.window;
      delete global.document;
    },
  };
}
const message = (id) => ({
  id,
  groupId: "group",
  channel: "general",
  senderId: "user",
  senderName: "User",
  senderRole: "VIEWER",
  text: id,
  createdAt: "2026-11-14T00:00:00Z",
});
async function flush() {
  for (let i = 0; i < 8; i++)
    await React.act(async () => {
      await new Promise(setImmediate);
    });
}

for (const scenario of [
  "older",
  "already loaded",
  "failure",
  "switch",
  "send",
  "reconnect",
  "slow latest after send",
]) {
  test(`direct search navigation: ${scenario}`, async () => {
    const env = setup();
    const requests = [];
    let state;
    let finishRequest;
    const handlers = {};
    const socket = {
      connected: true,
      on(event, handler) {
        handlers[event] = handler;
      },
      connect() {
        handlers.connect();
      },
      disconnect() {},
      emit(event, payload, ack) {
        if (event === "chat:send") ack({ ok: true, id: "sent" });
        if (event === "channel:join")
          ack({
            ok: true,
            messages: [
              message(scenario === "already loaded" ? "target" : "latest"),
            ],
            channels: [],
            nextCursor: "latest-page",
          });
      },
    };
    const { useGroupChat } = loadSource("lib/memberships/use-group-chat.ts", {
      "@/lib/realtime": { connectClassroom: () => socket },
      "@/lib/auth/session": { authSession: {} },
      "@/lib/api": {
        apiRequest: async (url) => {
          const params = new URL(url, "http://localhost").searchParams;
          requests.push(Object.fromEntries(params));
          if (scenario === "failure") throw new Error(scenario);
          if (scenario === "switch")
            return new Promise((resolve) => {
              finishRequest = resolve;
            });
          if (!params.has("around") && !params.has("direction"))
            return scenario === "slow latest after send"
              ? new Promise((resolve) => {
                  finishRequest = resolve;
                })
              : { items: [message("sent")], nextCursor: "latest-page" };
          if (params.get("direction") === "after")
            return { items: [message("newer")], nextCursor: null };
          return {
            items: [message("before"), message("target"), message("after")],
            nextCursor: "older-page",
            newerCursor: "newer-page",
          };
        },
      },
    });
    function Probe({ target = "target" }) {
      state = useGroupChat("group", "general", target);
      return null;
    }
    try {
      await React.act(async () => {
        env.root.render(React.createElement(Probe));
      });
      await flush();
      assert.equal(requests.length, scenario === "already loaded" ? 0 : 1);
      if (requests.length)
        assert.deepEqual(requests[0], {
          channel: "general",
          around: "target",
          limit: "20",
        });
      if (scenario === "older") {
        assert.ok(state.messages.some((item) => item.id === "target"));
        assert.ok(
          !state.messages.some((item) => item.id === "latest"),
          "no disconnected latest page",
        );
        assert.equal(state.hasNewer, true);
        await React.act(async () => {
          await state.loadNewer();
        });
        assert.deepEqual(requests[1], {
          channel: "general",
          cursor: "newer-page",
          direction: "after",
          limit: "20",
        });
        assert.equal(state.hasNewer, false);
        assert.ok(state.messages.some((item) => item.id === "newer"));
      }
      if (scenario === "failure") assert.match(state.error, /Không thể mở/);
      if (scenario === "switch") {
        assert.equal(state.loadingTarget, true);
        await React.act(async () =>
          env.root.render(React.createElement(Probe, { target: "latest" })),
        );
        assert.equal(state.loadingTarget, false);
        await React.act(async () =>
          finishRequest({
            items: [message("target")],
            nextCursor: null,
            newerCursor: null,
          }),
        );
        assert.deepEqual(
          state.messages.map((item) => item.id),
          ["latest"],
        );
      }
      if (scenario === "send") {
        await React.act(async () => {
          await state.send("hello");
        });
        assert.deepEqual(
          state.messages.map((item) => item.id),
          ["sent"],
        );
        assert.equal(state.hasNewer, false);
      }
      if (scenario === "slow latest after send") {
        let acknowledged = false;
        await React.act(async () => {
          void state.send("hello").then(() => {
            acknowledged = true;
          });
          await new Promise(setImmediate);
        });
        assert.equal(
          acknowledged,
          true,
          "sending must resolve at the socket ACK, not wait for history reload",
        );
        await React.act(async () =>
          finishRequest({ items: [message("sent")], nextCursor: null }),
        );
      }
      if (scenario === "reconnect") {
        assert.equal(state.hasNewer, true);
        await React.act(async () =>
          env.root.render(React.createElement(Probe, { target: null })),
        );
        await React.act(async () => handlers.connect());
        assert.equal(
          state.hasNewer,
          false,
          "rejoin must discard the old search window's forward cursor",
        );
        await React.act(async () => handlers["chat:message"](message("live")));
        assert.ok(state.messages.some((item) => item.id === "live"));
      }
      assert.equal(state.loadingOlder, false);
      assert.equal(state.loadingTarget, false);
    } finally {
      await env.cleanup();
    }
  });
}

test("centers a loaded search result once and lets the user keep scrolling", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const env = setup();
  const icon = () => null;
  const { WorkspaceChat } = loadSource("components/workspace-chat.tsx", {
    "next/link": { default: (props) => React.createElement("a", props) },
    "lucide-react": new Proxy({}, { get: () => icon }),
    "./ui": { Avatar: icon },
    "@/lib/memberships/use-chat-scroll": loadSource(
      "lib/memberships/use-chat-scroll.ts",
    ),
  });
  const proto = window.HTMLElement.prototype;
  Object.defineProperty(proto, "clientHeight", {
    get() {
      return 300;
    },
  });
  Object.defineProperty(proto, "scrollHeight", {
    get() {
      return 2000;
    },
  });
  Object.defineProperty(proto, "offsetHeight", {
    get() {
      return 40;
    },
  });
  const scrolls = [];
  proto.scrollTo = function (options) {
    scrolls.push(options);
    this.scrollTop = options.top;
    if (options.behavior === "smooth")
      setImmediate(() => this.dispatchEvent(new window.Event("scrollend")));
  };
  proto.getBoundingClientRect = function () {
    return {
      top: this.dataset.messageId
        ? 800 - this.parentElement.parentElement.scrollTop
        : 0,
    };
  };
  const chatMessage = (id) => ({
    ...message(id),
    name: "User",
    initials: "U",
    time: "00:00",
    color: "blue",
  });
  const props = {
    draft: "",
    onDraftChange() {},
    onSubmit() {},
    targetMessageId: "target",
  };
  try {
    await React.act(() =>
      env.root.render(
        React.createElement(WorkspaceChat, {
          ...props,
          messages: [chatMessage("latest")],
        }),
      ),
    );
    await React.act(() =>
      env.root.render(
        React.createElement(WorkspaceChat, {
          ...props,
          messages: [chatMessage("target"), chatMessage("latest")],
        }),
      ),
    );
    await flush();
    const history = document.querySelector(".chat-history");
    assert.equal(history.scrollTop, 670);
    assert.equal(scrolls.length, 2);
    assert.equal(scrolls[1].behavior, "smooth");
    assert.ok(
      document
        .querySelector('[data-message-id="target"]')
        .classList.contains("search-target"),
    );
    history.scrollTop = 400;
    await React.act(() =>
      history.dispatchEvent(new window.Event("scroll", { bubbles: true })),
    );
    await React.act(() =>
      env.root.render(
        React.createElement(WorkspaceChat, {
          ...props,
          messages: [
            chatMessage("target"),
            chatMessage("latest"),
            chatMessage("new"),
          ],
        }),
      ),
    );
    assert.equal(history.scrollTop, 400);
    await React.act(() => t.mock.timers.tick(4999));
    assert.ok(
      document
        .querySelector('[data-message-id="target"]')
        .classList.contains("search-target"),
    );
    await React.act(() => t.mock.timers.tick(1));
    assert.ok(
      !document
        .querySelector('[data-message-id="target"]')
        .classList.contains("search-target"),
    );
    assert.equal(
      history.scrollTop,
      400,
      "removing highlight does not move history",
    );
    assert.ok(
      document.querySelector('[data-message-id="target"]'),
      "message stays after highlight expires",
    );
  } finally {
    await env.cleanup();
  }
});

test("channel list survives chat changes and ignores late responses from another group", async () => {
  const env = setup();
  const sockets = [];
  const joins = [];
  let state;
  let createAck;
  const channel = (id, groupId = "group") => ({
    id,
    groupId,
    name: id,
    createdById: "user",
    createdAt: "2026-11-14T00:00:00Z",
  });
  const { useGroupChat } = loadSource("lib/memberships/use-group-chat.ts", {
    "@/lib/realtime": {
      connectClassroom: () => {
        const handlers = {};
        const socket = {
          connected: true,
          on(event, fn) {
            handlers[event] = fn;
          },
          connect() {
            handlers.connect();
          },
          disconnect() {},
          emit(event, payload, ack) {
            if (event === "channel:join") joins.push({ payload, ack });
            if (event === "chat:channel.create") createAck = ack;
          },
        };
        sockets.push(socket);
        return socket;
      },
    },
    "@/lib/auth/session": { authSession: {} },
    "@/lib/api": { apiRequest: async () => ({ items: [], nextCursor: null }) },
  });
  function Probe({ group = "group", chat = "general" }) {
    state = useGroupChat(group, chat);
    return null;
  }
  try {
    await React.act(async () => env.root.render(React.createElement(Probe)));
    await React.act(async () =>
      joins[0].ack({
        ok: true,
        messages: [],
        channels: [channel("custom-a")],
        nextCursor: null,
      }),
    );
    const original = state.channels;
    for (const chat of ["hỏi-đáp", "thông-báo", "general"]) {
      await React.act(async () =>
        env.root.render(React.createElement(Probe, { chat })),
      );
      assert.equal(
        state.channels,
        original,
        "changing chat must not clear or replace the channel list while awaiting ACK",
      );
    }
    const oldJoin = joins.at(-1);
    await React.act(async () =>
      oldJoin.ack({
        ok: true,
        messages: [],
        channels: [channel("custom-a")],
        nextCursor: null,
      }),
    );
    let created;
    await React.act(async () => {
      created = state.createChannel("late-created");
    });
    await React.act(async () =>
      env.root.render(
        React.createElement(Probe, { group: "other-group", chat: "general" }),
      ),
    );
    assert.deepEqual(
      state.channels,
      [],
      "new group must not display previous group channels",
    );
    await React.act(async () =>
      joins
        .at(-1)
        .ack({
          ok: true,
          messages: [],
          channels: [channel("custom-b", "other-group")],
          nextCursor: null,
        }),
    );
    await React.act(async () => {
      oldJoin.ack({
        ok: true,
        messages: [],
        channels: [channel("stale")],
        nextCursor: null,
      });
      createAck({ ok: true, channel: channel("late-created") });
      await created;
    });
    assert.deepEqual(
      state.channels.map((item) => item.name),
      ["custom-b"],
    );
  } finally {
    await env.cleanup();
  }
});
