import { Header } from "@/components/header"
import { HeroBackground } from "@/components/hero-background"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"

export default function Home() {
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
          <Textarea
            aria-label="Paste your tabs"
            placeholder={
              "Paste your tabs here...\n\nhttps://github.com/...\nhttps://arxiv.org/...\nhttps://amazon.in/..."
            }
            rows={8}
            className="w-full resize-none text-left text-sm sm:text-base"
          />
          <p className="mt-2 text-xs text-tertiary">
            Paste 20, 50, or even 100 tabs at once.
          </p>
          <Button size="lg" className="mt-6 w-full sm:w-auto">
            Dump my tabs →
          </Button>
        </div>
      </main>
    </div>
  )
}
