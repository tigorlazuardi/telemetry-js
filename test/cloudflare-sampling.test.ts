import type { Context } from "@opentelemetry/api";
import { ROOT_CONTEXT, SpanStatusCode, TraceFlags, trace } from "@opentelemetry/api";
import { SamplingDecision } from "@opentelemetry/sdk-trace-base";
import { describe, expect, it } from "vitest";
import {
	createRecordAllHeadSampler,
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

describe("createRecordAllHeadSampler", () => {
	function makeParentCtx(sampled: boolean): Context {
		const spanCtx = {
			traceId: "a".repeat(32),
			spanId: "b".repeat(16),
			traceFlags: sampled ? TraceFlags.SAMPLED : TraceFlags.NONE,
			isRemote: true,
		};
		return trace.setSpanContext(ROOT_CONTEXT, spanCtx);
	}

	it("ratio 1.0 → always RECORD_AND_SAMPLED for root spans", () => {
		const sampler = createRecordAllHeadSampler(1.0);
		const result = sampler.shouldSample(ROOT_CONTEXT, "a".repeat(32), "test", 0, {}, []);
		expect(result.decision).toBe(SamplingDecision.RECORD_AND_SAMPLED);
	});

	it("ratio 0.0 → always RECORD (never NOT_RECORD) for root spans", () => {
		const sampler = createRecordAllHeadSampler(0.0);
		const result = sampler.shouldSample(ROOT_CONTEXT, "a".repeat(32), "test", 0, {}, []);
		expect(result.decision).toBe(SamplingDecision.RECORD);
	});

	it("never returns NOT_RECORD for any ratio", () => {
		const sampler = createRecordAllHeadSampler(0.0);
		const traceIds = [
			"0".repeat(32),
			"f".repeat(32),
			"a1b2c3d4e5f60000a1b2c3d4e5f60000",
			"deadbeef".repeat(4),
		];
		for (const id of traceIds) {
			const result = sampler.shouldSample(ROOT_CONTEXT, id, "test", 0, {}, []);
			expect(result.decision).not.toBe(SamplingDecision.NOT_RECORD);
		}
	});

	it("remote sampled parent → RECORD_AND_SAMPLED (follow remote)", () => {
		const sampler = createRecordAllHeadSampler(0.0); // ratio 0 to force RECORD for root
		const ctx = makeParentCtx(true);
		const result = sampler.shouldSample(ctx, "b".repeat(32), "child", 0, {}, []);
		expect(result.decision).toBe(SamplingDecision.RECORD_AND_SAMPLED);
	});

	it("remote NOT-sampled parent → RECORD (not NOT_RECORD)", () => {
		const sampler = createRecordAllHeadSampler(1.0);
		const ctx = makeParentCtx(false);
		const result = sampler.shouldSample(ctx, "c".repeat(32), "child", 0, {}, []);
		expect(result.decision).toBe(SamplingDecision.RECORD);
	});

	it("toString includes ratio", () => {
		const sampler = createRecordAllHeadSampler(0.5);
		expect(sampler.toString()).toContain("0.5");
	});

	it("ratio 1.0 → RECORD_AND_SAMPLED even for traceId that accumulates to 0xffffffff", () => {
		// "ffffffff" + zeros accumulates to 0xffffffff which would fail `< 0xffffffff` without the saturated short-circuit
		const sampler = createRecordAllHeadSampler(1.0);
		const edgeId = "ffffffff" + "0".repeat(24);
		const result = sampler.shouldSample(ROOT_CONTEXT, edgeId, "test", 0, {}, []);
		expect(result.decision).toBe(SamplingDecision.RECORD_AND_SAMPLED);
	});
});
