import { describe, expect, it } from "bun:test";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getPackageName } = require("../../scripts/resolveBinary.cjs");

describe("getPackageName", () => {
	it("maps win32 platform to windows package", () => {
		expect(getPackageName("win32", "x64")).toBe("@ugudlado1/backlog-windows-x64");
	});

	it("returns linux name unchanged", () => {
		expect(getPackageName("linux", "arm64")).toBe("@ugudlado1/backlog-linux-arm64");
	});
});
