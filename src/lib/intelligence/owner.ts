"use client"

import { createId } from "@/lib/id"
import { scopedKey } from "@/lib/storage/namespace"

/**
 * Which Hubble account context detection belongs to, as the extension sees it.
 *
 * The extension's activity and the person's consent live in one Chrome
 * profile; a family or school computer can have several Hubble accounts using
 * it. Each account (and signed-out Hubble) gets its own random id, stored in
 * its own namespace and sent with every context command. The extension keeps
 * activity for the id that opted in and answers no other: another account
 * sees detection as not set up, gets nothing that was kept, and opting in
 * itself clears what was kept for the previous one before anything starts.
 *
 * The id is opaque and random — never the account id, an email or anything
 * that names the person.
 */
export const CONTEXT_OWNER_KEY = "tabdump:context-owner:v1"
const OWNER = /^[A-Za-z0-9-]{8,100}$/

let fallback: string | undefined

export function contextOwnerId(): string {
  const key = scopedKey(CONTEXT_OWNER_KEY)
  try {
    const stored = window.localStorage.getItem(key)
    if (stored && OWNER.test(stored)) return stored
    const minted = createId()
    window.localStorage.setItem(key, minted)
    return minted
  } catch {
    // No storage: one id for this page's life. The extension then treats a later visit as a different account,
    // which errs on the side of showing nothing.
    fallback ??= createId()
    return fallback
  }
}
