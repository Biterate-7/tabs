import { Header } from "@/components/header"
import { HeroBackground } from "@/components/hero-background"
import { TabInput } from "@/components/tab-input"
import type { Tab } from "@/lib/tabs/types"

export function LandingView({ onDump }: { onDump: (tabs: Tab[]) => void }) {
  return (
    <div className="relative flex min-h-screen flex-1 flex-col">
      <HeroBackground />
      <Header />
      <main className="relative mx-auto flex w-full max-w-3xl flex-1 flex-col items-center px-6 py-20 text-center sm:py-28">
        <h1 className="text-4xl font-semibold tracking-tight text-balance text-foreground sm:text-6xl">
          Your tabs are a mess.
          <br />
          Dump them.
        </h1>
        <p className="mt-5 max-w-xl text-base text-balance text-muted-foreground sm:text-lg">
          Paste your browser tabs and turn the chaos
          <br className="hidden sm:block" /> into an organized workspace.
        </p>

        <div className="mt-10 w-full">
          <TabInput onDump={onDump} />
        </div>
      </main>
    </div>
  )
}
