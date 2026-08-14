import { NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";
import { fetchDriveFileMetadata, type DriveFileMetadata } from "@/lib/google/drive-metadata";
import { mapWithConcurrency } from "@/lib/google/concurrency";

const CONCURRENCY = 4;
const MAX_FILE_IDS = 200;

type ResultsByFileId = Record<string, DriveFileMetadata | null>;

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const fileIds = parseFileIds(body);
  if (!fileIds) {
    return NextResponse.json({ error: "fileIds must be an array of strings" }, { status: 400 });
  }

  // getToken() decodes the encrypted session cookie directly, server-side
  // only. It is deliberately used instead of auth() here — see Task 6 Step
  // 2 — because the `session` callback (which auth() reads through) never
  // carries accessToken, to keep it out of the public /api/auth/session
  // response that useSession() polls client-side.
  //
  // secureCookie must match how the cookie was actually set (Auth.js sets
  // it based on whether the request was HTTPS — see @auth/core/lib/init.js).
  // Without this, getToken() looks for the unprefixed `authjs.session-token`
  // cookie while production sets `__Secure-authjs.session-token`, so the
  // session would never be found in any HTTPS deployment.
  const token = await getToken({
    req: request,
    secret: process.env.AUTH_SECRET,
    secureCookie: process.env.NODE_ENV === "production",
  });
  const accessToken = typeof token?.accessToken === "string" ? token.accessToken : undefined;

  if (!accessToken || token?.error) {
    return NextResponse.json({ authenticated: false, results: {} as ResultsByFileId });
  }

  const uniqueFileIds = Array.from(new Set(fileIds)).slice(0, MAX_FILE_IDS);
  const metadataList = await mapWithConcurrency(uniqueFileIds, CONCURRENCY, (fileId) =>
    fetchDriveFileMetadata(fileId, accessToken)
  );

  const results: ResultsByFileId = {};
  uniqueFileIds.forEach((fileId, index) => {
    results[fileId] = metadataList[index];
  });

  return NextResponse.json({ authenticated: true, results });
}

function parseFileIds(body: unknown): string[] | null {
  if (typeof body !== "object" || body === null || !("fileIds" in body)) return null;
  const { fileIds } = body as { fileIds: unknown };
  if (!Array.isArray(fileIds) || !fileIds.every((id) => typeof id === "string")) return null;
  return fileIds;
}
