import "server-only";
import { signOutDesktop } from "@/lib/auth/device-routes";

export const runtime = "nodejs";

/** Hubble Desktop signs itself out: its device token is deleted. See src/lib/auth/device.ts. */
export function POST(request: Request): Promise<Response> {
  return signOutDesktop(request);
}
