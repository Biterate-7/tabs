import { describe, expect, it } from "vitest";
import { isSafeToFetch } from "./ssrf-guard";

describe("isSafeToFetch", () => {
  it("allows ordinary public https/http URLs", () => {
    expect(isSafeToFetch("https://github.com/foo/bar")).toBe(true);
    expect(isSafeToFetch("http://example.com")).toBe(true);
  });

  it("rejects malformed URLs", () => {
    expect(isSafeToFetch("not a url")).toBe(false);
  });

  it("rejects non-http(s) protocols", () => {
    expect(isSafeToFetch("file:///etc/passwd")).toBe(false);
    expect(isSafeToFetch("ftp://example.com/x")).toBe(false);
  });

  it("rejects localhost and loopback", () => {
    expect(isSafeToFetch("http://localhost:3000")).toBe(false);
    expect(isSafeToFetch("http://127.0.0.1")).toBe(false);
    expect(isSafeToFetch("http://127.0.0.1:8080/admin")).toBe(false);
  });

  it("rejects private IPv4 ranges", () => {
    expect(isSafeToFetch("http://10.0.0.5")).toBe(false);
    expect(isSafeToFetch("http://192.168.1.1")).toBe(false);
    expect(isSafeToFetch("http://172.16.0.1")).toBe(false);
    expect(isSafeToFetch("http://172.31.255.255")).toBe(false);
  });

  it("allows public IPv4 addresses that merely look similar", () => {
    expect(isSafeToFetch("http://172.32.0.1")).toBe(true);
    expect(isSafeToFetch("http://172.15.0.1")).toBe(true);
    expect(isSafeToFetch("http://8.8.8.8")).toBe(true);
  });

  it("rejects link-local / cloud metadata addresses", () => {
    expect(isSafeToFetch("http://169.254.169.254/latest/meta-data")).toBe(false);
    expect(isSafeToFetch("http://metadata.google.internal")).toBe(false);
  });

  it("rejects .local hostnames", () => {
    expect(isSafeToFetch("http://my-nas.local")).toBe(false);
  });

  it("rejects IPv6 loopback and link-local", () => {
    expect(isSafeToFetch("http://[::1]")).toBe(false);
    expect(isSafeToFetch("http://[fe80::1]")).toBe(false);
  });
});
