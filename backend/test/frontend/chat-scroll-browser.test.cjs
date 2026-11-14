const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createServer } = require("node:http");
const { resolve } = require("node:path");
const { mkdir } = require("node:fs/promises");
const { build } = require("esbuild");
const { chromium } = require("playwright");

// Real component + production styles, without a database or a signed-in account.
async function fixture({
  qa = false,
  workspace = false,
  workspaceView = "chat",
  viewport = { width: 1200, height: 800 },
} = {}) {
  const root = resolve(__dirname, "../../..");
  const result = await build({
    stdin: {
      contents: `
      import React, {useState} from 'react';
      import {createRoot} from 'react-dom/client';
      import {WorkspaceChat} from './frontend/src/components/workspace-chat';
      import {WorkspaceThreads} from './frontend/src/components/workspace-threads';
      import {Workspace} from './frontend/src/components/workspace';
      import './frontend/src/app/globals.css';
      import './frontend/src/components/workspace-layout.css';
      window.rows = (start, end) => Array.from({length:end-start},(_,index)=> {
        const n=start+index;
        return {id:'m'+n, senderId:'u'+n, name:'User '+n, initials:'U', color:'blue',
          text: 'Message '+n+'\\n'+('variable height content\\n'.repeat(n%4)),
          time:'12:00',createdAt:new Date(1700000000000+n*60000).toISOString()};
      });
      function App(){
        const [state,setState]=useState({messages:[],hasOlder:true,historyReady:false,latestVersion:0});
        const [draft,setDraft]=useState('');
        window.setChat=patch=>setState(current=>({...current,...patch}));
        if (location.search.includes('workspace')) return <Workspace view={${JSON.stringify(workspaceView)}} />;
        if (location.search.includes('qa')) return <div className="app-shell"><main className="view-chat"><WorkspaceThreads groupId="group" userId="u0" /></main></div>;
        return <div className="app-shell"><main className="view-chat"><div className="community-chat">
          <WorkspaceChat {...state} draft={draft} onDraftChange={setDraft} onSubmit={event=>event.preventDefault()}
            welcome={<div className="chat-welcome"><h2>Beginning of the channel</h2></div>}
            onLoadOlder={async()=>{setState(s=>({...s,loadingOlder:true}));await new Promise(r=>setTimeout(r,50));setState(s=>({...s,messages:[...window.rows(60,80),...s.messages],hasOlder:false,loadingOlder:false}));}}
            onJumpToLatest={async()=>setState(s=>({...s,messages:window.rows(80,100),hasOlder:true,hasNewer:false,latestVersion:s.latestVersion+1}))}
          />
        </div></main></div>;
      }
      createRoot(document.getElementById('root')).render(<App/>);
    `,
      resolveDir: root,
      loader: "tsx",
    },
    bundle: true,
    write: false,
    outdir: resolve(root, ".preview/chat-scroll-bundle"),
    tsconfig: resolve(root, "frontend/tsconfig.json"),
    external: ["/fonts/*"],
    plugins: [
      {
        name: "link-stub",
        setup(builder) {
          builder.onResolve(
            {
              filter:
                /^(next\/navigation|client-only|@\/components\/auth\/auth-provider|\.\.?\/auth\/auth-provider|\.\.?\/common\/toast-provider|@\/components\/common\/toast-provider|@\/lib\/memberships\/use-workspace-group|@\/lib\/memberships\/use-group-permissions|@\/lib\/class-sessions\/use-workspace-meetings|\.\/memberships\/members-panel)$/,
            },
            (args) => ({ path: args.path, namespace: "workspace-fixture" }),
          );
          builder.onLoad(
            { filter: /.*/, namespace: "workspace-fixture" },
            (args) => {
              let contents;
              if (args.path === "client-only") contents = "";
              else if (args.path === "next/navigation")
                contents = `export const useRouter=()=>({push:()=>{window.routeNavigations=(window.routeNavigations??0)+1;}});export const usePathname=()=>location.pathname;export const useSearchParams=()=>new URLSearchParams(location.search);`;
              else if (args.path.endsWith("auth-provider"))
                contents = `const auth={user:{id:'u0',fullName:'Test User',email:'test@example.test',globalRole:'USER'},phase:'authenticated'};export const useAuth=()=>auth;`;
              else if (args.path.endsWith("toast-provider"))
                contents = `const toast={notify:()=>{}};export const useToast=()=>toast;`;
              else if (args.path.endsWith("use-workspace-group"))
                contents = `import {useEffect} from 'react';const groups=[{id:'group',name:'Sidebar test group'}];export function useWorkspaceGroup(){useEffect(()=>{window.groupLoads=(window.groupLoads??0)+1;},[]);return {groups,groupId:'group',loading:false,error:null,selectGroup:()=>{}};}`;
              else if (args.path.endsWith("use-group-permissions"))
                contents = `const access={permissions:{role:'OWNER',canHost:true,canUpload:true},loading:false,error:null,revision:0,membershipRevision:0};export const useGroupPermissions=()=>access;`;
              else if (args.path.endsWith("use-workspace-meetings"))
                contents = `const rooms={items:[],loading:false,error:null,refresh:async()=>{}};export const useWorkspaceMeetings=()=>rooms;`;
              else
                contents = `export const MembersPanel=()=>null;export const NoGroupSelected=()=>null;`;
              return { contents, loader: "js", resolveDir: root };
            },
          );
          builder.onResolve(
            { filter: /^@\/lib\/(api|memberships\/use-group-chat)$/ },
            (args) => ({ path: args.path, namespace: "chat-fixture" }),
          );
          builder.onLoad(
            { filter: /.*/, namespace: "chat-fixture" },
            (args) => ({
              contents: args.path.endsWith("/api")
                ? `
              const thread={id:'11111111-1111-4111-8111-111111111111',title:'Chủ đề bố cục',createdAt:'2026-11-13T00:00:00Z',createdById:'u0',groupId:'group'};
              export class ApiError extends Error{};export const asApiError=error=>error;
              export async function apiRequest(path){
                if(path.includes('/folders')) return {folders:[],breadcrumbs:[],currentFolder:null};
                if(path.includes('/files?')||path.includes('/sessions')) return {items:[],nextCursor:null};
                return path.includes('/threads?')?{items:[thread],nextCursor:null}:{thread};
              }
            `
                : `
              import {useState} from 'react';
              export function useGroupChat(groupId, channel){
                const [state,setState]=useState({messages:[],hasOlder:false,hasNewer:false,latestVersion:0});
                window.setThreadChat=patch=>setState(s=>({...s,...patch,...(patch.messages?{messages:patch.messages.map(m=>({...m,senderName:m.name,senderRole:'VIEWER'}))}:{})}));
                return {...state,messages:groupId?state.messages:[],historyReady:!!groupId,status:groupId?'connected':'idle',channels:[{id:'custom',name:'custom-channel'}],error:null,
                  loadOlder:async()=>{},loadNewer:async()=>{},loadLatest:async()=>{},
                  send:async(text,replyToId,clientId)=>{
                    (window.sentMessages??=[]).push({text,clientId,channel});
                    await new Promise(resolve=>setTimeout(resolve,window.sendDelay??0));
                    if(window.failSend) throw new Error('Simulated save failure');
                    const message={id:clientId,clientId,groupId,channel,text,replyToId,senderId:'u0',senderName:'User',senderRole:'VIEWER',createdAt:new Date().toISOString()};
                    setState(s=>({...s,messages:[...s.messages.filter(m=>m.id!==message.id),message]}));
                    return message.id;
                  },edit:async()=>{},remove:async()=>{}};
              }
            `,
              loader: "js",
              resolveDir: root,
            }),
          );
          builder.onResolve({ filter: /^next\/link$/ }, () => ({
            path: "link",
            namespace: "stub",
          }));
          builder.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
            contents:
              "import React from 'react';export default function Link({children, onClick, ...props}) { return React.createElement('a',{...props,onClick:event=>{onClick?.(event);if(!event.defaultPrevented){event.preventDefault();window.routeNavigations=(window.routeNavigations??0)+1;}}},children); }",
            loader: "js",
            resolveDir: root,
          }));
        },
      },
    ],
  });
  const js = result.outputFiles.find((file) => file.path.endsWith(".js")).text;
  const css = result.outputFiles.find((file) =>
    file.path.endsWith(".css"),
  ).text;
  const server = createServer((req, res) => {
    if (req.url === "/app.js") {
      res.setHeader("Content-Type", "text/javascript");
      res.end(js);
    } else if (req.url === "/app.css") {
      res.setHeader("Content-Type", "text/css");
      res.end(css);
    } else if (req.url.startsWith("/fonts/")) {
      res.writeHead(404);
      res.end();
    } else {
      res.setHeader("Content-Type", "text/html");
      res.end(
        `<!doctype html><html><head><link rel="stylesheet" href="/app.css"><style>${workspace ? "" : ".app-shell{display:block!important;height:100dvh!important;padding:0!important}.view-chat{height:100%;padding:20px!important}.community-chat{height:100%}.chat-history{max-height:100%}"}</style></head><body><div id="root"></div><script src="/app.js"></script></body></html>`,
      );
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      channel: process.platform === "win32" ? "msedge" : undefined,
    });
  } catch (error) {
    await new Promise((resolve) => server.close(resolve));
    throw error;
  }
  const page = await browser.newPage({ viewport });
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on("pageerror", (error) => {
    errors.push(error.message);
    console.error("Browser error:", error.message);
  });
  await page.goto(
    `http://127.0.0.1:${server.address().port}/${qa ? "?qa" : workspace ? "?workspace" : ""}`,
  );
  await page.waitForFunction(() => Boolean(window.setChat));
  return {
    page,
    errors,
    async screenshot(name) {
      if (!process.env.STREAMORA_CHAT_SCREENSHOTS) return;
      const directory = resolve(root, ".preview/chat-layout-review");
      await mkdir(directory, { recursive: true });
      await page.screenshot({ path: resolve(directory, name), fullPage: true });
    },
    async close() {
      await browser.close();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
async function bottom(page) {
  await page.waitForFunction(() => {
    const el = document.querySelector(".chat-history");
    return el.scrollHeight - el.scrollTop - el.clientHeight < 2;
  });
}

test("real browser: latest on entry, resize, stable prepend and typing", async () => {
  const f = await fixture();
  const { page } = f;
  try {
    assert.equal(await page.locator(".chat-welcome").count(), 0);
    await page.evaluate(() =>
      window.setChat({ messages: window.rows(80, 100), historyReady: true }),
    );
    await bottom(page);
    assert.equal(await page.locator(".chat-welcome").count(), 0);
    await page.setViewportSize({ width: 900, height: 600 });
    await bottom(page);
    await page.evaluate(() =>
      window.setChat({ messages: window.rows(80, 101) }),
    );
    await bottom(page);
    await page.locator(".chat-history").evaluate((el) => (el.scrollTop = 200));
    await page.waitForTimeout(60);
    const anchor = await page.evaluate(() => {
      const el = document.querySelector(".chat-history");
      const top = el.getBoundingClientRect().top;
      const row = [...el.querySelectorAll("[data-message-id]")].find(
        (row) => row.getBoundingClientRect().bottom > top,
      );
      return {
        id: row.dataset.messageId,
        top: row.getBoundingClientRect().top - top,
      };
    });
    await page
      .getByRole("button", { name: "Xem tin nhắn cũ hơn", exact: true })
      .evaluate((el) => el.click());
    await page.waitForFunction(() =>
      Boolean(document.querySelector('[data-message-id="m60"]')),
    );
    const offset = await page
      .locator(`[data-message-id="${anchor.id}"]`)
      .evaluate(
        (el) =>
          el.getBoundingClientRect().top -
          document.querySelector(".chat-history").getBoundingClientRect().top,
      );
    assert.ok(
      Math.abs(offset - anchor.top) < 2,
      `anchor changed by ${offset - anchor.top}px`,
    );
    assert.equal(await page.locator(".chat-welcome").count(), 1);
    const before = await page
      .locator(".chat-history")
      .evaluate((el) => el.scrollTop);
    await page.evaluate(() =>
      window.setChat({ messages: window.rows(60, 102) }),
    );
    await page.waitForFunction(() =>
      Boolean(document.querySelector('[data-message-id="m101"]')),
    );
    await page
      .getByRole("textbox", { name: "Tin nhắn", exact: true })
      .fill("Typing without moving history");
    assert.equal(
      await page.locator(".chat-history").evaluate((el) => el.scrollTop),
      before,
    );
    await page
      .getByRole("button", { name: "Đi tới tin mới nhất ↓", exact: true })
      .click();
    await bottom(page);
    assert.deepEqual(f.errors, []);
  } finally {
    await f.close();
  }
});

test("real browser: search animates briefly, highlight expires, latest returns to bottom", async () => {
  const f = await fixture();
  const { page } = f;
  try {
    await page.evaluate(() =>
      window.setChat({ messages: window.rows(80, 100), historyReady: true }),
    );
    await bottom(page);
    const positions = await page.evaluate(async () => {
      const el = document.querySelector(".chat-history");
      window.setChat({ targetMessageId: "m20", loadingTarget: true });
      await new Promise((r) => setTimeout(r, 80));
      window.setChat({
        messages: window.rows(0, 41),
        hasOlder: true,
        hasNewer: true,
        loadingTarget: false,
      });
      await new Promise((r) => setTimeout(r, 40));
      const points = [];
      const started = performance.now();
      await new Promise((resolve) => {
        function tick() {
          points.push(el.scrollTop);
          if (performance.now() - started < 650) requestAnimationFrame(tick);
          else resolve();
        }
        requestAnimationFrame(tick);
      });
      return points;
    });
    assert.ok(
      new Set(positions.map(Math.round)).size >= 4,
      "expected several intermediate animation frames",
    );
    await page.locator('[data-message-id="m20"].search-target').waitFor();
    const centerError = await page
      .locator('[data-message-id="m20"]')
      .evaluate((row) => {
        const el = document.querySelector(".chat-history");
        return Math.abs(
          row.getBoundingClientRect().top +
            row.offsetHeight / 2 -
            (el.getBoundingClientRect().top + el.clientHeight / 2),
        );
      });
    assert.ok(centerError < 3, `center error ${centerError}px`);
    assert.equal(await page.locator(".chat-welcome").count(), 0);
    await page.waitForFunction(
      () => !document.querySelector(".search-target"),
      {},
      { timeout: 6500 },
    );
    assert.equal(await page.locator('[data-message-id="m20"]').count(), 1);
    await page
      .getByRole("button", { name: "Đi tới tin mới nhất ↓", exact: true })
      .click();
    await bottom(page);
    await page.waitForTimeout(100);
    assert.equal(await page.locator('[data-message-id="m99"]').count(), 1);
    assert.deepEqual(f.errors, []);
  } finally {
    await f.close();
  }
});

test("real browser: tall search result shows its first lines and reduced motion is respected", async () => {
  const f = await fixture();
  const { page } = f;
  try {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.evaluate(() => {
      const rows = window.rows(0, 41);
      rows[20].text = "First line\n" + "Tall message content\n".repeat(500);
      window.setChat({
        messages: rows,
        historyReady: true,
        targetMessageId: "m20",
        hasOlder: true,
        hasNewer: true,
      });
    });
    await page.locator('[data-message-id="m20"].search-target').waitFor();
    const top = await page
      .locator('[data-message-id="m20"]')
      .evaluate(
        (row) =>
          row.getBoundingClientRect().top -
          document.querySelector(".chat-history").getBoundingClientRect().top,
      );
    assert.ok(
      Math.abs(top - 16) < 2,
      "tall result must align to its first line: " + top,
    );
    assert.deepEqual(f.errors, []);
  } finally {
    await f.close();
  }
});

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`Q&A real component: aligned short replies and fixed composer at ${viewport.width}px`, async () => {
    const f = await fixture({ qa: true, viewport });
    const { page } = f;
    try {
      await page
        .getByRole("button")
        .filter({ hasText: "Chủ đề bố cục" })
        .click();
      await page.evaluate(() =>
        window.setThreadChat({ messages: window.rows(0, 2) }),
      );
      await page.locator('.qa-conversation [data-message-id="m1"]').waitFor();
      const bounds = await page.evaluate(() => {
        const rect = (selector) => {
          const el = document.querySelector(selector);
          const r = el.getBoundingClientRect();
          return {
            left: r.left,
            right: r.right,
            top: r.top,
            bottom: r.bottom,
            width: r.width,
            height: r.height,
          };
        };
        return {
          messages: rect(".qa-conversation .messages"),
          composer: rect(".qa-conversation .chat-composer-row"),
          header: rect(".qa-conversation > header"),
          first: rect(".qa-conversation .message"),
          history: rect(".qa-conversation .chat-history"),
          form: rect(".qa-conversation .chat-form"),
          bodyWidth: document.body.scrollWidth,
          viewport: innerWidth,
        };
      });
      assert.ok(
        Math.abs(bounds.messages.left - bounds.composer.left) < 2,
        JSON.stringify(bounds),
      );
      assert.ok(
        Math.abs(bounds.messages.width - bounds.composer.width) < 2,
        JSON.stringify(bounds),
      );
      assert.ok(
        bounds.first.top - bounds.header.bottom < 60,
        "short discussion should start below header, not at bottom",
      );
      assert.ok(
        bounds.history.bottom <= bounds.form.top + 1,
        "composer should not overlap history",
      );
      assert.ok(bounds.bodyWidth <= bounds.viewport, "no horizontal overflow");
      await f.screenshot(`qa-short-${viewport.width}.png`);
      const formTop = bounds.form.top;
      await page.evaluate(() =>
        window.setThreadChat({ messages: window.rows(0, 55), hasOlder: true }),
      );
      await bottom(page);
      const control = await page
        .locator(".chat-history-more")
        .first()
        .evaluate((el) => ({
          width: el.getBoundingClientRect().width,
          parent: el.parentElement.getBoundingClientRect().width,
        }));
      assert.ok(
        control.width < control.parent * 0.8,
        "history control must not stretch across the column",
      );
      const formAfter = await page
        .locator(".qa-conversation .chat-form")
        .evaluate((el) => el.getBoundingClientRect().top);
      assert.equal(formAfter, formTop);
      await f.screenshot(`qa-history-${viewport.width}.png`);
      await page
        .locator(".qa-conversation .chat-history")
        .evaluate((el) => (el.scrollTop = 200));
      await page
        .getByRole("button", { name: "Đi tới tin mới nhất ↓", exact: true })
        .waitFor();
      assert.equal(
        await page
          .locator(".qa-conversation .chat-form")
          .evaluate((el) => el.getBoundingClientRect().top),
        formTop,
        "floating latest button must not move the composer",
      );
      assert.deepEqual(f.errors, []);
    } finally {
      await f.close();
    }
  });
}

test("short history automatically fills the viewport and never leaves a stretched history button", async () => {
  const f = await fixture();
  const { page } = f;
  try {
    await page.evaluate(() =>
      window.setChat({
        messages: window.rows(80, 82),
        historyReady: true,
        hasOlder: true,
      }),
    );
    await page.waitForFunction(() =>
      Boolean(document.querySelector('[data-message-id="m60"]')),
    );
    await bottom(page);
    await f.screenshot("common-history-filled.png");
    assert.equal(await page.locator(".chat-history-more").count(), 0);
    assert.equal(await page.locator(".chat-welcome").count(), 1);
    await page.evaluate(() =>
      window.setChat({ messages: window.rows(98, 100), hasOlder: false }),
    );
    await page.waitForFunction(
      () => document.querySelectorAll("[data-message-id]").length === 2,
    );
    assert.equal(await page.locator(".chat-history-more").count(), 0);
    assert.deepEqual(f.errors, []);
  } finally {
    await f.close();
  }
});

test("Q&A preserves optimistic send, focus, newer draft and retry ID with slow/failed saves", async () => {
  const f = await fixture({ qa: true });
  const { page } = f;
  try {
    await page.getByRole("button").filter({ hasText: "Chủ đề bố cục" }).click();
    const input = page.getByRole("textbox", { name: "Tin nhắn", exact: true });
    await page.evaluate(() => {
      window.sendDelay = 1800;
    });
    await input.fill("Slow acknowledged message");
    await input.press("Enter");
    await page
      .locator(".message.pending")
      .filter({ hasText: "Slow acknowledged message" })
      .waitFor();
    assert.equal(await input.inputValue(), "");
    assert.equal(
      await input.evaluate((el) => document.activeElement === el),
      true,
    );
    await input.fill("Draft written before ACK");
    await page.waitForFunction(
      () => !document.querySelector(".message.pending"),
    );
    assert.equal(await input.inputValue(), "Draft written before ACK");
    assert.equal(
      await page
        .locator(".message")
        .filter({ hasText: "Slow acknowledged message" })
        .count(),
      1,
    );
    await page.evaluate(() => {
      window.sendDelay = 50;
      window.failSend = true;
    });
    await input.fill("Retry exact content");
    await input.press("Enter");
    await page
      .getByRole("button", { name: "Thử gửi lại", exact: true })
      .waitFor();
    await input.fill("Preserve this newer draft");
    await page.evaluate(() => {
      window.failSend = false;
    });
    await page
      .getByRole("button", { name: "Thử gửi lại", exact: true })
      .click();
    await page.waitForFunction(
      () => !document.querySelector(".qa-send-errors"),
    );
    assert.equal(await input.inputValue(), "Preserve this newer draft");
    assert.equal(
      await page
        .locator(".message")
        .filter({ hasText: "Retry exact content" })
        .count(),
      1,
    );
    const attempts = await page.evaluate(() =>
      window.sentMessages.filter((item) => item.text === "Retry exact content"),
    );
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0].clientId, attempts[1].clientId);
    assert.deepEqual(f.errors, []);
  } finally {
    await f.close();
  }
});

test("workspace channel navigation keeps sidebar nodes mounted and supports back/forward", async () => {
  const f = await fixture({
    workspace: true,
    viewport: { width: 1440, height: 900 },
  });
  const { page } = f;
  try {
    const sidebar = page.locator(".channel-sidebar");
    await sidebar.locator(".custom-channels .channel").waitFor();
    await page.evaluate(() => {
      window.sidebarNode = document.querySelector(".channel-sidebar");
      window.channelNode = document.querySelector(".custom-channels .channel");
    });
    for (const name of [
      "hỏi-đáp",
      "thông-báo",
      "custom-channel",
      "trò-chuyện-chung",
    ]) {
      await sidebar.getByRole("link").filter({ hasText: name }).click();
      await page.waitForFunction(
        (name) =>
          document
            .querySelector(".channel-sidebar .channel.selected")
            ?.textContent.includes(name),
        name,
      );
      assert.equal(
        await page.evaluate(
          () =>
            window.sidebarNode === document.querySelector(".channel-sidebar"),
        ),
        true,
      );
      assert.equal(
        await page.evaluate(
          () =>
            window.channelNode ===
            document.querySelector(".custom-channels .channel"),
        ),
        true,
      );
      assert.equal(
        await page.evaluate(() =>
          new URL(location.href).searchParams.get("groupId"),
        ),
        "group",
      );
    }
    await page.goBack();
    await page.waitForFunction(() =>
      document
        .querySelector(".channel-sidebar .channel.selected")
        ?.textContent.includes("custom-channel"),
    );
    await page.goForward();
    await page.waitForFunction(() =>
      document
        .querySelector(".channel-sidebar .channel.selected")
        ?.textContent.includes("trò-chuyện-chung"),
    );
    assert.equal(await page.evaluate(() => window.groupLoads), 1);
    assert.equal(await page.evaluate(() => window.routeNavigations ?? 0), 0);
    assert.deepEqual(f.errors, []);
  } finally {
    await f.close();
  }
});

for (const workspaceView of ["chat", "files"]) {
  test(`workspace ${workspaceView}: files and recordings open without reload, with back/forward`, async () => {
    const f = await fixture({
      workspace: true,
      workspaceView,
      viewport: { width: 1440, height: 900 },
    });
    const { page } = f;
    try {
      const sidebar = page.locator(".channel-sidebar");
      await sidebar.locator(".custom-channels .channel").waitFor();
      await page.evaluate(() => {
        window.sidebarNode = document.querySelector(".channel-sidebar");
      });
      for (const chat of ["hỏi-đáp", "thông-báo", "trò-chuyện-chung"]) {
        await sidebar.getByRole("link").filter({ hasText: chat }).click();
        await page.locator(".view-chat").waitFor();
        for (const name of ["Tài liệu chung", "Bản ghi bài giảng"]) {
          await sidebar.getByRole("link", { name, exact: true }).click();
          await page
            .getByRole("textbox", { name: "Tìm tên tài liệu", exact: true })
            .waitFor({ timeout: 1500 });
          assert.equal(
            await page
              .locator('.file-filters button[aria-pressed="true"]')
              .textContent(),
            name === "Tài liệu chung" ? "Tất cả" : "Video và bản ghi",
          );
          assert.equal(
            await page.evaluate(
              () =>
                window.sidebarNode ===
                document.querySelector(".channel-sidebar"),
            ),
            true,
          );
          assert.equal(
            await page.evaluate(() => new URL(location.href).pathname),
            "/files",
          );
          assert.equal(
            await page.evaluate(() =>
              new URL(location.href).searchParams.get("groupId"),
            ),
            "group",
          );
        }
        await page.goBack();
        await page.waitForFunction(
          () =>
            document.querySelector('.file-filters button[aria-pressed="true"]')
              ?.textContent === "Tất cả",
        );
        await page.goBack();
        await page.waitForFunction(
          (chat) =>
            document
              .querySelector(".channel-sidebar .channel.selected")
              ?.textContent.includes(chat),
          chat,
        );
        await page.goForward();
        await page
          .getByRole("textbox", { name: "Tìm tên tài liệu", exact: true })
          .waitFor();
      }
      assert.equal(await page.evaluate(() => window.groupLoads), 1);
      assert.equal(await page.evaluate(() => window.routeNavigations ?? 0), 0);
      assert.deepEqual(f.errors, []);
    } finally {
      await f.close();
    }
  });
}
