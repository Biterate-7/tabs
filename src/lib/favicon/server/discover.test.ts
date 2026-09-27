// @vitest-environment node
import { describe, expect, it } from "vitest";
import { discoverIcons } from "./discover";

const urls = (html: string, page = "https://site.com/") => discoverIcons(html, page).map((icon) => icon.url);

describe("discoverIcons", () => {
  it("finds rel=icon, rel='shortcut icon' and apple-touch-icon declarations", () => {
    const html = `<head>
      <link rel="apple-touch-icon" href="/touch.png">
      <link rel="shortcut icon" href="/legacy.ico">
      <link rel="stylesheet" href="/app.css">
      <link rel="mask-icon" href="/mask.svg" color="#000">
    </head>`;
    expect(urls(html)).toEqual(["https://site.com/legacy.ico", "https://site.com/touch.png"]);
  });

  it("resolves relative, root-relative, absolute and protocol-relative hrefs against the page", () => {
    const html = `
      <link rel="icon" href="img/a.png" sizes="32x32">
      <link rel="icon" href="/b.png" sizes="32x32">
      <link rel="icon" href="https://cdn.site-static.com/c.png" sizes="32x32">
      <link rel="icon" href="//cdn.other.net/d.png" sizes="32x32">`;
    expect(urls(html, "https://www.site.com/app/index.html")).toEqual([
      "https://www.site.com/app/img/a.png",
      "https://www.site.com/b.png",
      "https://cdn.site-static.com/c.png",
      "https://cdn.other.net/d.png",
    ]);
  });

  it("resolves against the page's final (post-redirect) URL and honours <base href>", () => {
    expect(urls(`<link rel="icon" href="fav.png">`, "https://new.site.com/home/")).toEqual([
      "https://new.site.com/home/fav.png",
    ]);
    expect(urls(`<base href="https://static.site.com/assets/"><link rel="icon" href="fav.png">`)).toEqual([
      "https://static.site.com/assets/fav.png",
    ]);
  });

  it("parses Next.js-style tags like Hubble's own (hashed query strings, sizes, types)", () => {
    const html = `<!DOCTYPE html><html><head><meta charSet="utf-8"/>
      <link rel="icon" href="/favicon.ico?favicon.38e20fl_719mw.ico" sizes="48x48" type="image/x-icon"/>
      <link rel="icon" href="/icon.png?icon.3x-vget-3-0dj.png" sizes="512x512" type="image/png"/>
      <link rel="apple-touch-icon" href="/apple-icon.png?apple-icon.02jm7k7poz05i.png" sizes="180x180" type="image/png"/>
      </head><body></body></html>`;
    expect(discoverIcons(html, "https://hubble-hq.vercel.app/")).toEqual([
      { url: "https://hubble-hq.vercel.app/favicon.ico?favicon.38e20fl_719mw.ico", rel: "icon", size: 48 },
      { url: "https://hubble-hq.vercel.app/icon.png?icon.3x-vget-3-0dj.png", rel: "icon", size: 512 },
      { url: "https://hubble-hq.vercel.app/apple-icon.png?apple-icon.02jm7k7poz05i.png", rel: "apple-touch-icon", size: 180 },
    ]);
  });

  it("prefers scalable, then sharp-and-close-to-64px icons; tiny ones last", () => {
    const html = `
      <link rel="icon" href="/16.png" sizes="16x16">
      <link rel="icon" href="/192.png" sizes="192x192">
      <link rel="icon" href="/unknown.ico">
      <link rel="icon" href="/32.png" sizes="32x32">
      <link rel="icon" href="/logo.svg" type="image/svg+xml">`;
    expect(urls(html)).toEqual([
      "https://site.com/logo.svg",
      "https://site.com/32.png",
      "https://site.com/192.png",
      "https://site.com/unknown.ico",
      "https://site.com/16.png",
    ]);
  });

  it("decodes entities, accepts unquoted and single-quoted attributes, and ignores attribute order", () => {
    const html = `<link href='/i.png?v=1&amp;t=2' REL=icon><link sizes=32x32 href=/j.png rel="icon">`;
    expect(urls(html)).toEqual(["https://site.com/j.png", "https://site.com/i.png?v=1&t=2"]);
  });

  it("keeps inline data: image icons and drops unusable schemes and empty hrefs", () => {
    const html = `
      <link rel="icon" href="data:image/png;base64,iVBORw0KGgo=">
      <link rel="icon" href="javascript:alert(1)">
      <link rel="icon" href="chrome://favicon/x">
      <link rel="icon" href="">
      <link rel="icon">`;
    expect(urls(html)).toEqual(["data:image/png;base64,iVBORw0KGgo="]);
  });

  it("ignores links in comments, scripts and the body, and de-duplicates", () => {
    const html = `<head>
      <!-- <link rel="icon" href="/commented.png"> -->
      <script>document.write('<link rel="icon" href="/scripted.png">')</script>
      <link rel="icon" href="/real.png">
      <link rel="shortcut icon" href="/real.png">
    </head><body><link rel="icon" href="/body.png"></body>`;
    expect(urls(html)).toEqual(["https://site.com/real.png"]);
  });

  it("returns nothing for a page with no declarations or an unparsable page URL", () => {
    expect(urls("<html><head><title>x</title></head></html>")).toEqual([]);
    expect(discoverIcons(`<link rel="icon" href="/a.png">`, "not a url")).toEqual([]);
  });
});
