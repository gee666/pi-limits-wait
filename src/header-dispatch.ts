import { ExtensionRunner, type ModelRegistry } from "@earendil-works/pi-coding-agent";
import { state } from "./state.js";
import type { ModelsSimpleStreamOptions } from "@earendil-works/pi-ai";

// Pi does not expose its header dispatcher to extensions. Recover the runner
// from the contexts it creates, rather than replaying a source-model closure
// (which may inject source credentials) against another provider's headers.
// This exported-class interception is unsupported; keep it isolated and cover
// actual CLI fallback, reload and session replacement at the transport boundary.
const SLOT = Symbol.for("oira666.pi-limits-wait.header-dispatch.v1");
interface DispatchSlot {
  runners: WeakMap<ModelRegistry, ExtensionRunner>;
  wrapper: ExtensionRunner["createContext"];
}
type RunnerPrototype = ExtensionRunner & { [SLOT]?: DispatchSlot };

export function installHeaderDispatch(): void {
  const prototype = ExtensionRunner.prototype as RunnerPrototype;
  if (prototype[SLOT]?.wrapper === prototype.createContext) return;
  const previous = prototype.createContext;
  const runners = new WeakMap<ModelRegistry, ExtensionRunner>();
  const wrapper = function (this: ExtensionRunner) {
    const context = previous.call(this);
    // modelRegistry is a getter that throws once the runner is stale (after
    // reload / session replacement). Never let that crash pi.
    try {
      runners.set(context.modelRegistry, this);
    } catch {
      // stale runner: skip registration
    }
    return context;
  };
  Object.defineProperty(prototype, SLOT, { configurable: true, value: { runners, wrapper } });
  prototype.createContext = wrapper;
}

export function fallbackHeaderTransform(): ModelsSimpleStreamOptions["transformHeaders"] {
  let registry: ModelRegistry | undefined;
  try {
    registry = state.sharedCtx?.modelRegistry;
  } catch {
    return undefined; // stale ctx after reload / session replacement
  }
  const runner = registry && (ExtensionRunner.prototype as RunnerPrototype)[SLOT]?.runners.get(registry);
  return runner ? (headers) => runner.emitBeforeProviderHeaders(headers) : undefined;
}
