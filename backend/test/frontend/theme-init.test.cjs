const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

const source = readFileSync(
  resolve(__dirname, "../../../frontend/src/lib/theme.ts"),
  "utf8",
);
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS },
}).outputText;
const themeModule = { exports: {} };
vm.runInNewContext(compiled, { exports: themeModule.exports });
const { DEFAULT_THEME, THEME_STORAGE_KEY, themeInitScript } = themeModule.exports;

for (const [name, saved, expected] of [
  ["first visit", {}, "dark"],
  ["previous light preference", { "streamora-theme": "light" }, "dark"],
  ["new light preference", { [THEME_STORAGE_KEY]: "light" }, "light"],
  ["new dark preference", { [THEME_STORAGE_KEY]: "dark" }, "dark"],
  ["invalid preference", { [THEME_STORAGE_KEY]: "invalid" }, "dark"],
]) {
  test(`theme initialization handles ${name}`, () => {
    const dataset = { theme: DEFAULT_THEME };
    vm.runInNewContext(themeInitScript, {
      document: { documentElement: { dataset } },
      localStorage: { getItem: (key) => saved[key] ?? null },
    });
    assert.equal(dataset.theme, expected);
  });
}

test("dark mode survives blocked browser storage", () => {
  const dataset = { theme: DEFAULT_THEME };
  vm.runInNewContext(themeInitScript, {
    document: { documentElement: { dataset } },
    get localStorage() {
      throw new Error("Storage is blocked");
    },
  });
  assert.equal(dataset.theme, "dark");
});
