// @vitest-environment node
import { describe, expect, it } from "vitest";
import { isPublicAddress } from "./address";

describe("isPublicAddress", () => {
  it("allows ordinary public addresses", () => {
    for (const address of ["8.8.8.8", "142.250.72.14", "76.76.21.21", "2607:f8b0:4005:80a::200e", "2606:4700::6810:84e5"]) {
      expect(isPublicAddress(address), address).toBe(true);
    }
  });

  it("refuses loopback, private, link-local and metadata IPv4", () => {
    for (const address of [
      "127.0.0.1",
      "127.8.9.10",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "192.0.2.10",
      "198.18.0.1",
      "224.0.0.1",
      "255.255.255.255",
    ]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
    // The edges of the private ranges are public.
    expect(isPublicAddress("172.15.255.255")).toBe(true);
    expect(isPublicAddress("172.32.0.1")).toBe(true);
    expect(isPublicAddress("100.128.0.1")).toBe(true);
  });

  it("refuses non-global IPv6, including IPv4-mapped private addresses", () => {
    for (const address of [
      "::",
      "::1",
      "fe80::1",
      "fc00::1",
      "fd12:3456::1",
      "ff02::1",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "::ffff:169.254.169.254",
      "64:ff9b::a00:1",
      "2001:db8::1",
      "2002:a00:1::1",
      "fe80::1%eth0",
    ]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
    expect(isPublicAddress("::ffff:8.8.8.8")).toBe(true);
  });

  it("refuses anything that is not an IP address", () => {
    expect(isPublicAddress("example.com")).toBe(false);
    expect(isPublicAddress("")).toBe(false);
  });
});
