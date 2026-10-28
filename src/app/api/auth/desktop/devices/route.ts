import "server-only";
import { listDesktops, revokeDesktop } from "@/lib/auth/device-routes";

export const runtime = "nodejs";

/** The Hubble Desktop installs signed in to this account, for Settings → Account on the web. */
export function GET(request: Request): Promise<Response> {
  return listDesktops(request);
}

/** Signs one of them out: `{ revoke: id }`. */
export function POST(request: Request): Promise<Response> {
  return revokeDesktop(request);
}
