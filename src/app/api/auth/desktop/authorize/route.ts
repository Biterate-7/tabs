import "server-only";
import { authorizeDesktop } from "@/lib/auth/device-routes";

export const runtime = "nodejs";

/** Hubble Desktop sign-in, step one: a signed-in web session mints a single-use pairing code. See src/lib/auth/device.ts. */
export function POST(request: Request): Promise<Response> {
  return authorizeDesktop(request);
}
