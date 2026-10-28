import "server-only";
import { exchangeDesktopCode } from "@/lib/auth/device-routes";

export const runtime = "nodejs";

/** Hubble Desktop sign-in, step two: the app trades the code and its PKCE verifier for a device token. See src/lib/auth/device.ts. */
export function POST(request: Request): Promise<Response> {
  return exchangeDesktopCode(request);
}
