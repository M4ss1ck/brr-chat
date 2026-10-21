// A server link is the one thing a person pastes or a QR code carries (#18, ADR 0020). These
// are the shapes the server actually emits: a bare origin, /signup/<token>, /join/<token>.
import { describe, expect, test } from "bun:test";
import { parseServerLink, serverIdOf, serverLabel, serverOfUrl } from "../src/servers.ts";

const TOKEN = "abcdefghijklmnopqrstuv"; // 22 base64url chars, like newInviteToken()

describe("server links", () => {
  test("a bare origin is a server with no invite", () => {
    expect(parseServerLink("https://chat.example")).toEqual({ server: "https://chat.example", invite: null });
    expect(parseServerLink("  https://chat.example/  ")).toEqual({ server: "https://chat.example", invite: null });
    expect(parseServerLink("http://127.0.0.1:3000")).toEqual({ server: "http://127.0.0.1:3000", invite: null });
  });

  test("a typed address without a scheme assumes https, or http on loopback", () => {
    expect(parseServerLink("chat.example")?.server).toBe("https://chat.example");
    expect(parseServerLink("chat.example:8443")?.server).toBe("https://chat.example:8443");
    expect(parseServerLink("localhost:3000")?.server).toBe("http://localhost:3000");
    expect(parseServerLink("127.0.0.1:3000")?.server).toBe("http://127.0.0.1:3000");
    expect(parseServerLink("[::1]:3000")?.server).toBe("http://[::1]:3000");
  });

  test("a server invite keeps its token for the next signup", () => {
    expect(parseServerLink(`https://chat.example/signup/${TOKEN}`)).toEqual({
      server: "https://chat.example",
      invite: { kind: "signup", token: TOKEN },
    });
    expect(parseServerLink(`https://chat.example/signup/${TOKEN}/`)?.invite).toEqual({
      kind: "signup",
      token: TOKEN,
    });
  });

  test("a group invite keeps its token for the next join", () => {
    expect(parseServerLink(`https://chat.example/join/${TOKEN}`)).toEqual({
      server: "https://chat.example",
      invite: { kind: "join", token: TOKEN },
    });
  });

  test("the same link in a QR code parses to the same thing", () => {
    const link = `https://chat.example/signup/${TOKEN}`;
    expect(parseServerLink(link)).toEqual(parseServerLink(link.trim()));
  });

  test("anything else is rejected instead of guessed at", () => {
    expect(parseServerLink("")).toBeNull();
    expect(parseServerLink("not a url")).toBeNull();
    expect(parseServerLink("ftp://chat.example")).toBeNull();
    expect(parseServerLink("javascript:alert(1)")).toBeNull();
    expect(parseServerLink("https://user:password@chat.example")).toBeNull();
    expect(parseServerLink("https://chat.example/unknown/path")).toBeNull();
    expect(parseServerLink("https://chat.example/signup/short")).toBeNull();
    expect(parseServerLink(`https://chat.example/signup/${TOKEN}/extra`)).toBeNull();
  });

  test("the id is the canonical origin, so a link and its QR share one list entry", () => {
    expect(serverIdOf("https://Chat.Example:443")).toBe("https://chat.example");
    expect(serverIdOf("http://chat.example:80/")).toBe("http://chat.example");
    expect(serverIdOf("https://chat.example/signup/token")).toBe("https://chat.example");
    expect(serverIdOf("chrome-extension://abc")).toBeNull();
    expect(serverIdOf("")).toBeNull();
  });

  test("labels and request origins are small and stable", () => {
    expect(serverLabel("https://chat.example:8443")).toBe("chat.example:8443");
    expect(serverLabel("not a url")).toBe("not a url");
    expect(serverOfUrl("https://chat.example/sync")).toBe("https://chat.example");
    expect(serverOfUrl("nope")).toBeNull();
  });
});
