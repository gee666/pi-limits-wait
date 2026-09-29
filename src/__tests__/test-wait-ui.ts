import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { CustomEditor, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { state } from "../state.js";
import { installWaitRetryEditor, waitForRetry } from "../ui.js";

// Resolve the host's own TUI, rather than a second copy with different keybindings.
const hostRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const { TUI, SelectList } = await import(hostRequire.resolve("@earendil-works/pi-tui"));
type Factory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;
const terminal = { columns: 100, rows: 40, write() {} };
const tui = new TUI(terminal);
tui.requestRender = () => {};
const identity = (text: string) => text;
const selectTheme = {
  selectedPrefix: identity, selectedText: identity, description: identity,
  scrollInfo: identity, noMatch: identity,
};
const theme = { borderColor: identity, selectList: selectTheme };
// CustomEditor needs only matches for app-level actions in these tests.
const keybindings = { matches: () => false } as unknown as Parameters<Factory>[2];
let factory: Factory | undefined;
let editor: ReturnType<Factory>;
let replacements = 0;
const submitted: string[] = [];
const ctx = {
  mode: "tui",
  ui: {
    getEditorComponent: () => factory,
    setEditorComponent(next: Factory) {
      factory = next;
      replacements++;
      const text = editor?.getText() ?? "";
      editor = next(tui, theme, keybindings);
      editor.setText(text);
      // Match InteractiveMode: callback assignment happens after construction.
      editor.onSubmit = (text) => { submitted.push(text); };
      tui.setFocus(editor);
    },
    setWorkingMessage() {},
  },
} as unknown as ExtensionContext;
state.sharedCtx = ctx;
installWaitRetryEditor(ctx);
assert.ok(editor! instanceof CustomEditor);

// Use real TUI focus routing and real editor submit/key decoding.
const input = (data: string) => tui.handleInput(data);
for (const enter of ["\r", "\x1b[13u"]) {
  const waiting = waitForRetry("rate-limit", 60_000);
  input(enter);
  assert.equal(await waiting, "skipped");
  assert.equal(state.activeWaitSkips.size, 0);
}
assert.deepEqual(submitted, []);

const controller = new AbortController();
const waiting = waitForRetry("rate-limit", 60_000, controller.signal);
for (const command of ["/model", "/settings", "/limits-wait"]) {
  editor!.setText(command);
  input("\r");
  assert.equal(submitted.at(-1), command);
  assert.equal(state.activeWaitSkips.size, 1);
}
editor!.setText("ordinary prompt");
input("\r");
assert.equal(submitted.at(-1), "ordinary prompt");
assert.equal(state.activeWaitSkips.size, 1);

// Exercise the editor's own command-completion picker, including an empty
// editor with Tab completion. Enter accepts that completion, not retry-now.
editor!.setAutocompleteProvider!({
  getSuggestions: async () => ({
    prefix: editor!.getText().startsWith("/") ? "/" : "",
    items: [{ value: "/model", label: "Model" }, { value: "/settings", label: "Settings" }],
  }),
  applyCompletion: (_lines, _line, _col, item) => ({
    lines: [item.value], cursorLine: 0, cursorCol: item.value.length,
  }),
});
for (const prefix of ["", "/"]) {
  editor!.setText(prefix);
  input("\t");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal((editor! as CustomEditor).isShowingAutocomplete(), true);
  input("\x1b[B");
  input("\r");
  assert.equal(state.activeWaitSkips.size, 1);
  if (prefix) assert.equal(submitted.at(-1), "/settings");
  else assert.equal(editor!.getText(), "/settings");
}
editor!.setText("");

// The main editor is now empty, but a picker owns focus. Navigation and
// confirmation must reach the picker without ending the wait.
let selected: string | undefined;
const picker = new SelectList([
  { value: "first", label: "First" }, { value: "second", label: "Second" },
], 5, selectTheme);
picker.onSelect = (item: { value: string }) => { selected = item.value; };
tui.setFocus(picker);
input("\x1b[B");
input("\r");
assert.equal(selected, "second");
assert.equal(state.activeWaitSkips.size, 1);
controller.abort();
assert.equal(await waiting, "aborted");
assert.equal(replacements, 1, "wait cleanup must not replace editor or move focus");
selected = undefined;
input("\r");
assert.equal(selected, "second");

// A wait can also start and expire while the picker already owns focus.
assert.equal(await waitForRetry("rate-limit", 5), "waited");
assert.equal(replacements, 1);
selected = undefined;
input("\r");
assert.equal(selected, "second");
assert.equal(state.activeWaitSkips.size, 0);
tui.setFocus(editor!);
input("\r");
assert.equal(submitted.at(-1), "", "outside a wait, preserve host submit behavior");

// Compose with an editor installed by another extension.
const baseEditor = editor!;
factory = () => baseEditor;
installWaitRetryEditor(ctx);
assert.equal(editor!, baseEditor);
const composedWait = waitForRetry("rate-limit", 60_000);
input("\r");
assert.equal(await composedWait, "skipped");

// Pi resets the factory before session_start on reload, copying draft text
// but not history. Its later rebuildChatFromMessages does not populate history.
const branch = [
  { type: "message", message: { role: "user", content: "earlier prompt" } },
  { type: "message", message: { role: "assistant", content: [{ type: "text", text: "answer" }] } },
  { type: "message", message: { role: "user", content: [
    { type: "text", text: "latest " }, { type: "image", data: "ignored" },
    { type: "text", text: "prompt" },
  ] } },
  { type: "message", message: { role: "user", content: [{ type: "image", data: "ignored" }] } },
];
const historyCtx = {
  ...ctx,
  sessionManager: { getBranch: () => branch },
} as unknown as ExtensionContext;
const recall = () => { input("\x1b[A"); return editor!.getText(); };

// Startup is populated by Pi after session_start. Seeding it ourselves would
// create a second copy of the branch, observable by pressing Up a third time.
factory = undefined;
editor!.setText("");
installWaitRetryEditor(historyCtx, "startup");
assert.equal(recall(), "");
editor!.addToHistory!("earlier prompt");
editor!.addToHistory!("latest prompt");
assert.equal(recall(), "latest prompt");
assert.equal(recall(), "earlier prompt");
assert.equal(recall(), "earlier prompt");

for (let reload = 0; reload < 2; reload++) {
  factory = undefined;
  editor!.setText("unfinished draft");
  installWaitRetryEditor(historyCtx, "reload");
  assert.equal(editor!.getText(), "unfinished draft");
  editor!.setText("");
  assert.equal(recall(), "latest prompt");
  assert.equal(recall(), "earlier prompt");
  assert.equal(recall(), "earlier prompt", "reload must not duplicate history");
}

for (const mode of ["rpc", "json", "print"] as const) {
  installWaitRetryEditor({ ...ctx, mode, ui: {} } as ExtensionContext);
}
state.sharedCtx = undefined;
console.log("Waiting UI regression tests passed");
