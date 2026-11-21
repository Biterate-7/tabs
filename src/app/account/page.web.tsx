import type { Metadata } from "next"
import { AccountPage } from "@/components/account-page/account-page"

export const metadata: Metadata = {
  title: "Your Hubble account",
  robots: { index: false, follow: false },
}

/** `/account` — website only: sign in, and disconnect Hubble Desktop apps from the account. */
export default function AccountRoute() {
  return <AccountPage />
}
