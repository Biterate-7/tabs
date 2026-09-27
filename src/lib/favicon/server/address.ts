import "server-only";
import { isIP } from "node:net";

/**
 * Whether the favicon resolver may open a connection to `address`.
 *
 * This is the SSRF boundary, and it is checked against the address the
 * socket is actually about to connect to (see ./safe-fetch.ts's lookup
 * hook) rather than against the hostname in a URL. A hostname check alone
 * is defeated by any public name whose A record points inward — including
 * one that resolves differently on the second lookup (DNS rebinding).
 *
 * Allow-by-exception for IPv6 (only global unicast, 2000::/3) and
 * deny-listed ranges for IPv4, both covering every IANA special-purpose
 * block that could reach something other than the public internet.
 */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPublicIPv4(address);
  if (family === 6) return isPublicIPv6(address);
  return false;
}

function isPublicIPv4(address: string): boolean {
  const [a, b, c] = address.split(".").map(Number);
  if (a === 0) return false; // "this network"
  if (a === 10) return false; // private
  if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
  if (a === 127) return false; // loopback
  if (a === 169 && b === 254) return false; // link-local, cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return false; // private
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false; // IETF protocol assignments, TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return false; // 6to4 relay anycast
  if (a === 192 && b === 168) return false; // private
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a === 198 && b === 51 && c === 100) return false; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return false; // TEST-NET-3
  if (a >= 224) return false; // multicast, reserved, broadcast
  return true;
}

/** Expands any valid IPv6 text form (including `::` and a dotted IPv4 tail) to eight 16-bit groups. */
function ipv6Groups(address: string): number[] {
  let text = address.toLowerCase();
  const zone = text.indexOf("%");
  if (zone !== -1) text = text.slice(0, zone);

  const dotted = text.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const [p, q, r, s] = dotted[1].split(".").map(Number);
    text = `${text.slice(0, -dotted[1].length)}${((p << 8) | q).toString(16)}:${((r << 8) | s).toString(16)}`;
  }

  const [head, tail] = text.includes("::") ? text.split("::") : [text, undefined];
  const headGroups = head ? head.split(":") : [];
  const tailGroups = tail ? tail.split(":") : [];
  const missing = tail === undefined ? 0 : 8 - headGroups.length - tailGroups.length;
  return [...headGroups, ...Array(missing).fill("0"), ...tailGroups].map((group) => parseInt(group, 16));
}

function isPublicIPv6(address: string): boolean {
  const g = ipv6Groups(address);

  // IPv4-mapped (::ffff:a.b.c.d): the connection really goes to the IPv4 address.
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    return isPublicIPv4(`${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`);
  }

  // Everything outside global unicast: ::, ::1, fc00::/7, fe80::/10, ff00::/8, 64:ff9b::/96 …
  if ((g[0] & 0xe000) !== 0x2000) return false;
  if (g[0] === 0x2001 && g[1] < 0x0200) return false; // 2001::/23 IETF special purpose (incl. Teredo)
  if (g[0] === 0x2001 && g[1] === 0x0db8) return false; // documentation
  if (g[0] === 0x2002) return false; // 6to4 — tunnels to an arbitrary embedded IPv4 address
  return true;
}
