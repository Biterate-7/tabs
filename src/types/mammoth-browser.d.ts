// mammoth ships its types for the Node entry point; its self-contained browser bundle is the same API.
declare module "mammoth/mammoth.browser.min.js" {
  const mammoth: typeof import("mammoth")
  export default mammoth
}
