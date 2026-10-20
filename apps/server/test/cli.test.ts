// The CLI's default base URL is what BetterAuth checks the browser's Origin against. A URL
// without the port rejects the app the server is actually serving, so pin the default here.
import { describe, expect, test } from "bun:test";
import { parseCliOptions } from "../src/index.ts";

describe("CLI options", () => {
  test("the default base URL is the URL the server prints, port included", () => {
    expect(parseCliOptions([], {}).baseURL).toBe("http://localhost:3000");
    expect(parseCliOptions(["--host", "0.0.0.0", "--port", "4017"], {}).baseURL).toBe("http://0.0.0.0:4017");
  });

  test("BASE_URL and --base-url override the derived default", () => {
    expect(parseCliOptions([], { BASE_URL: "https://chat.example" }).baseURL).toBe("https://chat.example");
    expect(
      parseCliOptions(["--base-url", "https://a.example"], { BASE_URL: "https://b.example" }).baseURL,
    ).toBe("https://a.example");
  });

  test("flags still win over the environment for the socket and the DB", () => {
    const opts = parseCliOptions(["--port", "4017", "--db", "/tmp/chat.db"], { PORT: "9000", DB_PATH: "/tmp/other.db" });
    expect(opts.port).toBe(4017);
    expect(opts.dbPath).toBe("/tmp/chat.db");
  });
});
