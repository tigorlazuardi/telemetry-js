import { withTrace, type WithTraceOptions } from "./with-trace.js";

/** Context passed to the traced factory function at each method call. */
export interface TracedCallContext {
  /** Class name (from `this.constructor.name`). */
  className: string;
  /** Decorated method name. */
  methodName: string;
  /** Arguments passed to the method call. */
  args: unknown[];
}

/** Input for {@link traced} — static options or factory function. */
export type TracedInput =
  | WithTraceOptions
  | ((ctx: TracedCallContext) => WithTraceOptions);

/**
 * TC39 Stage 3 method decorator that wraps the method body in a
 * {@link withTrace} span.
 *
 * @param optsOrFactory - Static {@link WithTraceOptions} or a factory that
 *   receives {@link TracedCallContext} and returns options per call.
 *
 * @example
 * ```ts
 * class UserService {
 *   @traced()
 *   async getUser(id: string) { // span = "UserService.getUser"
 *   }
 *
 *   @traced({ name: "custom-op", kind: SpanKind.CLIENT })
 *   async fetchExternal() { // span = "custom-op"
 *   }
 *
 *   @traced(({ args }) => ({
 *     attributes: { "user.id": String(args[0]) },
 *   }))
 *   async updateUser(id: string) { // span = "UserService.updateUser"
 *   }
 * }
 * ```
 */
export function traced(optsOrFactory?: TracedInput) {
  return function <This, Args extends unknown[], Return>(
    target: (this: This, ...args: Args) => Return,
    context: ClassMethodDecoratorContext<
      This,
      (this: This, ...args: Args) => Return
    >,
  ): (this: This, ...args: Args) => Return {
    const methodName = String(context.name);

    return function (this: This, ...args: Args): Return {
      const className =
        (this as { constructor?: { name?: string } })?.constructor?.name ??
        "unknown";
      const defaultName = `${className}.${methodName}`;

      const opts: WithTraceOptions =
        typeof optsOrFactory === "function"
          ? optsOrFactory({ className, methodName, args })
          : { ...optsOrFactory };

      if (!opts.name) opts.name = defaultName;

      return withTrace(() => target.call(this, ...args), opts) as Return;
    };
  };
}
