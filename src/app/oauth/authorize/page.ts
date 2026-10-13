// A `.ts` page on purpose: the desktop build resolves only `.tsx` pages, so
// this OAuth endpoint is part of the web deployment and never of the static
// desktop export. See src/components/integrations/oauth-consent-route.tsx.
export { default, metadata } from "@/components/integrations/oauth-consent-route";
