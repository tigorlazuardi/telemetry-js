import { scopeAction, withAction } from "../../shared/action.js";
import { injectContext } from "../../shared/context.js";
import { createLogger, setDefaultLogger } from "../../shared/logger.js";
import { traced } from "../../shared/traced.js";
import type { SDKConfig } from "../../shared/types.js";
import { withTrace } from "../../shared/with-trace.js";
import { browserAdapter } from "../adapter.js";

export const impl = {
	withTrace,
	withAction,
	scopeAction,
	traced,
	injectContext,
	createLogger,
	setDefaultLogger,
	setup: (config: SDKConfig) => browserAdapter.setup(config),
};
