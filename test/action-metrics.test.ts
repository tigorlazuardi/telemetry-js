import { metrics } from "@opentelemetry/api";
import {
	AggregationTemporality,
	InMemoryMetricExporter,
	MeterProvider,
	PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _resetActionMetrics, withAction } from "../src/shared/action.js";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeProvider() {
	const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
	const reader = new PeriodicExportingMetricReader({
		exporter,
		exportIntervalMillis: 100_000, // effectively manual — we call forceFlush()
	});
	const provider = new MeterProvider({ readers: [reader] });
	return { provider, exporter, reader };
}

// ── setup / teardown ─────────────────────────────────────────────────────────

let cleanup: (() => Promise<void>) | undefined;

beforeEach(() => {
	_resetActionMetrics();
});

afterEach(async () => {
	if (cleanup) {
		await cleanup();
		cleanup = undefined;
	}
	// Reset to noop provider so subsequent tests start clean.
	metrics.disable();
	_resetActionMetrics();
});

// ── tests ─────────────────────────────────────────────────────────────────────

describe("action metrics — ui.action.duration", () => {
	it("success sync: records 1 data point with correct attrs, no error.type, unit = 's'", async () => {
		const { provider, exporter, reader } = makeProvider();
		metrics.setGlobalMeterProvider(provider);
		cleanup = () => provider.shutdown();

		withAction("submit", () => 42, { page: "/home", component: "MyForm" });

		await reader.forceFlush();
		const resourceMetrics = exporter.getMetrics();
		expect(resourceMetrics.length).toBeGreaterThan(0);

		const scopeMetrics = resourceMetrics.flatMap((rm) => rm.scopeMetrics);
		const durationMetric = scopeMetrics
			.flatMap((sm) => sm.metrics)
			.find((m) => m.descriptor.name === "ui.action.duration");

		expect(durationMetric).toBeDefined();
		expect(durationMetric!.descriptor.unit).toBe("s");

		const dataPoints = durationMetric!.dataPoints;
		expect(dataPoints.length).toBe(1);

		const dp = dataPoints[0];
		expect(dp.attributes).toMatchObject({
			"ui.action": "submit",
			"ui.component": "MyForm",
			"ui.page": "/home",
		});
		expect(dp.attributes).not.toHaveProperty("error.type");
	});

	it("success async: records after promise resolves; value > 0", async () => {
		const { provider, exporter, reader } = makeProvider();
		metrics.setGlobalMeterProvider(provider);
		cleanup = () => provider.shutdown();

		await withAction("load", async () => {
			await new Promise((r) => setTimeout(r, 5));
			return "done";
		});

		await reader.forceFlush();
		const resourceMetrics = exporter.getMetrics();

		const durationMetric = resourceMetrics
			.flatMap((rm) => rm.scopeMetrics)
			.flatMap((sm) => sm.metrics)
			.find((m) => m.descriptor.name === "ui.action.duration");

		expect(durationMetric).toBeDefined();
		const dp = durationMetric!.dataPoints[0];
		// sum field holds total recorded duration (seconds); must be > 0
		const sum = (dp.value as { sum: number }).sum;
		expect(sum).toBeGreaterThan(0);
	});

	it("throwing sync fn: error.type = class name, error re-thrown", async () => {
		const { provider, exporter, reader } = makeProvider();
		metrics.setGlobalMeterProvider(provider);
		cleanup = () => provider.shutdown();

		class MyError extends Error {
			name = "MyError";
		}
		const err = new MyError("boom");

		expect(() =>
			withAction("click", () => {
				throw err;
			}),
		).toThrow(err);

		await reader.forceFlush();
		const resourceMetrics = exporter.getMetrics();

		const durationMetric = resourceMetrics
			.flatMap((rm) => rm.scopeMetrics)
			.flatMap((sm) => sm.metrics)
			.find((m) => m.descriptor.name === "ui.action.duration");

		expect(durationMetric).toBeDefined();
		const dp = durationMetric!.dataPoints[0];
		expect(dp.attributes).toMatchObject({
			"ui.action": "click",
			"error.type": "MyError",
		});
	});

	it("throwing async fn: error.type = class name, error re-thrown", async () => {
		const { provider, exporter, reader } = makeProvider();
		metrics.setGlobalMeterProvider(provider);
		cleanup = () => provider.shutdown();

		class FetchError extends Error {
			name = "FetchError";
		}
		const err = new FetchError("network");

		await expect(
			withAction("fetch", async () => {
				throw err;
			}),
		).rejects.toThrow(err);

		await reader.forceFlush();
		const resourceMetrics = exporter.getMetrics();

		const durationMetric = resourceMetrics
			.flatMap((rm) => rm.scopeMetrics)
			.flatMap((sm) => sm.metrics)
			.find((m) => m.descriptor.name === "ui.action.duration");

		expect(durationMetric).toBeDefined();
		const dp = durationMetric!.dataPoints[0];
		expect(dp.attributes).toHaveProperty("error.type", "FetchError");
	});
});

describe("action metrics — ui.action.active", () => {
	it("returns to 0 after sync settle", async () => {
		const { provider, exporter, reader } = makeProvider();
		metrics.setGlobalMeterProvider(provider);
		cleanup = () => provider.shutdown();

		withAction("submit", () => 1);
		withAction("submit", () => 2);

		await reader.forceFlush();
		const resourceMetrics = exporter.getMetrics();

		const activeMetric = resourceMetrics
			.flatMap((rm) => rm.scopeMetrics)
			.flatMap((sm) => sm.metrics)
			.find((m) => m.descriptor.name === "ui.action.active");

		expect(activeMetric).toBeDefined();
		// Cumulative sum of all +1/-1 adds = 0
		const dp = activeMetric!.dataPoints[0];
		expect(dp.value as number).toBe(0);
	});

	it("returns to 0 after async settle", async () => {
		const { provider, exporter, reader } = makeProvider();
		metrics.setGlobalMeterProvider(provider);
		cleanup = () => provider.shutdown();

		await withAction("load", async () => "ok");

		await reader.forceFlush();
		const resourceMetrics = exporter.getMetrics();

		const activeMetric = resourceMetrics
			.flatMap((rm) => rm.scopeMetrics)
			.flatMap((sm) => sm.metrics)
			.find((m) => m.descriptor.name === "ui.action.active");

		expect(activeMetric).toBeDefined();
		const dp = activeMetric!.dataPoints[0];
		expect(dp.value as number).toBe(0);
	});
});

describe("action metrics — no provider", () => {
	it("does not throw when no MeterProvider is registered (noop)", () => {
		// afterEach resets provider; here we run without setting one
		expect(() => withAction("click", () => 42)).not.toThrow();
	});

	it("does not throw on async action when no provider", async () => {
		await expect(withAction("load", async () => "ok")).resolves.toBe("ok");
	});
});
