import { SpanStatusCode, TraceFlags } from "@opentelemetry/api";
import { describe, expect, it } from "vitest";
import {
	keepAll,
	keepOnError,
	keepOnHeadSampled,
	keepOnSlow,
	multiTailSampler,
} from "../src/cloudflare/sampling.js";
import type { LocalTrace } from "../src/shared/types.js";

function makeTrace(
	overrides: Partial<{
		statusCode: number;
		traceFlags: number;
		startTime: [number, number];
		endTime: [number, number];
	}>,
): LocalTrace {
	const statusCode = overrides.statusCode ?? SpanStatusCode.UNSET;
	const traceFlags = overrides.traceFlags ?? TraceFlags.NONE;
	const startTime: [number, number] = overrides.startTime ?? [0, 0];
	const endTime: [number, number] = overrides.endTime ?? [0, 0];

	const rootSpan = {
		name: "root",
		kind: 0,
		spanContext: () => ({
			traceId: "abc123",
			spanId: "root001",
			traceFlags,
		}),
		parentSpanContext: undefined,
		startTime,
		endTime,
		status: { code: statusCode },
		attributes: {},
		links: [],
		events: [],
		duration: [endTime[0] - startTime[0], endTime[1] - startTime[1]] as [number, number],
		ended: true,
		resource: {} as any,
		instrumentationScope: { name: "test" },
		droppedAttributesCount: 0,
		droppedEventsCount: 0,
		droppedLinksCount: 0,
	} as any;

	return {
		traceId: "abc123",
		spans: [rootSpan],
		rootSpan,
	};
}

describe("keepOnError", () => {
	it("returns true when root span status is ERROR", () => {
		const trace = makeTrace({ statusCode: SpanStatusCode.ERROR });
		expect(keepOnError(trace)).toBe(true);
	});

	it("returns false for UNSET status", () => {
		const trace = makeTrace({ statusCode: SpanStatusCode.UNSET });
		expect(keepOnError(trace)).toBe(false);
	});

	it("returns false for OK status", () => {
		const trace = makeTrace({ statusCode: SpanStatusCode.OK });
		expect(keepOnError(trace)).toBe(false);
	});
});

describe("keepOnHeadSampled", () => {
	it("returns true when SAMPLED flag is set", () => {
		const trace = makeTrace({ traceFlags: TraceFlags.SAMPLED });
		expect(keepOnHeadSampled(trace)).toBe(true);
	});

	it("returns false when SAMPLED flag is not set", () => {
		const trace = makeTrace({ traceFlags: TraceFlags.NONE });
		expect(keepOnHeadSampled(trace)).toBe(false);
	});
});

describe("keepAll", () => {
	it("always returns true", () => {
		expect(keepAll(makeTrace({}))).toBe(true);
		expect(keepAll(makeTrace({ statusCode: SpanStatusCode.UNSET }))).toBe(true);
	});
});

describe("keepOnSlow", () => {
	it("returns true when duration exceeds threshold", () => {
		// 200ms duration (0.2s)
		const trace = makeTrace({ startTime: [0, 0], endTime: [0, 200_000_000] });
		expect(keepOnSlow(100)(trace)).toBe(true);
	});

	it("returns false when duration is below threshold", () => {
		// 50ms duration
		const trace = makeTrace({ startTime: [0, 0], endTime: [0, 50_000_000] });
		expect(keepOnSlow(100)(trace)).toBe(false);
	});

	it("returns false when duration equals threshold (strict >)", () => {
		// exactly 100ms
		const trace = makeTrace({ startTime: [0, 0], endTime: [0, 100_000_000] });
		expect(keepOnSlow(100)(trace)).toBe(false);
	});

	it("handles seconds-level durations", () => {
		// 1.5s = 1500ms > 1000ms threshold
		const trace = makeTrace({ startTime: [0, 0], endTime: [1, 500_000_000] });
		expect(keepOnSlow(1000)(trace)).toBe(true);
	});
});

describe("multiTailSampler", () => {
	it("returns true when any sampler returns true (OR logic)", () => {
		const trace = makeTrace({ statusCode: SpanStatusCode.ERROR });
		// keepOnHeadSampled is false (no SAMPLED flag), keepOnError is true
		const sampler = multiTailSampler([keepOnHeadSampled, keepOnError]);
		expect(sampler(trace)).toBe(true);
	});

	it("returns false when all samplers return false", () => {
		const trace = makeTrace({ statusCode: SpanStatusCode.OK, traceFlags: TraceFlags.NONE });
		const sampler = multiTailSampler([keepOnError, keepOnHeadSampled]);
		expect(sampler(trace)).toBe(false);
	});

	it("returns true when first sampler matches (short-circuits)", () => {
		const trace = makeTrace({ traceFlags: TraceFlags.SAMPLED });
		const sampler = multiTailSampler([keepOnHeadSampled, keepOnError]);
		expect(sampler(trace)).toBe(true);
	});

	it("returns false for empty sampler list", () => {
		const trace = makeTrace({ statusCode: SpanStatusCode.ERROR });
		expect(multiTailSampler([])(trace)).toBe(false);
	});
});
