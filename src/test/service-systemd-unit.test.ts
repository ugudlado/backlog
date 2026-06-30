import { describe, expect, it } from "bun:test";
import { renderUnit } from "../commands/service.ts";

describe("systemd unit rendering", () => {
	it("embeds the resolved binary path in ExecStart (so it can't drift)", () => {
		const unit = renderUnit("/home/trader/.npm-global/bin/backlog", 6420);
		expect(unit).toContain("ExecStart=/home/trader/.npm-global/bin/backlog server --port 6420");
	});

	it("honors a custom port", () => {
		const unit = renderUnit("/usr/local/bin/backlog", 7000);
		expect(unit).toContain("--port 7000");
	});

	it("is a complete, installable user unit", () => {
		const unit = renderUnit("/usr/local/bin/backlog", 6420);
		// The three sections systemd needs to load + enable the unit.
		expect(unit).toContain("[Unit]");
		expect(unit).toContain("[Service]");
		expect(unit).toContain("WantedBy=default.target");
	});
});
