/**
 * The real sites the compatibility check opens, in six kinds. Chosen to be
 * what agents visit: docs, news, shops, code and forums, web apps, and
 * plain information sites. Some block headless browsers; then every browser
 * fails them alike, and they're left out of the "same as Chrome" score.
 *
 * Used by: compat.ts
 */
export const COMPAT_SITES: { kind: string; url: string }[] = [
  { kind: "Docs", url: "https://en.wikipedia.org/wiki/Web_browser" },
  { kind: "Docs", url: "https://developer.mozilla.org/en-US/docs/Web/JavaScript" },
  { kind: "Docs", url: "https://docs.python.org/3/" },
  { kind: "Docs", url: "https://react.dev/" },
  { kind: "Docs", url: "https://nodejs.org/en" },
  { kind: "Docs", url: "https://www.rust-lang.org/" },
  { kind: "Docs", url: "https://go.dev/doc/" },
  { kind: "Docs", url: "https://tailwindcss.com/docs/installation" },
  { kind: "Docs", url: "https://learn.microsoft.com/en-us/dotnet/csharp/" },
  { kind: "Docs", url: "https://playwright.dev/docs/intro" },

  { kind: "News", url: "https://www.bbc.com/news" },
  { kind: "News", url: "https://www.theverge.com/" },
  { kind: "News", url: "https://techcrunch.com/" },
  { kind: "News", url: "https://edition.cnn.com/" },
  { kind: "News", url: "https://www.theguardian.com/international" },
  { kind: "News", url: "https://www.wired.com/" },
  { kind: "News", url: "https://apnews.com/" },
  { kind: "News", url: "https://www.npr.org/" },
  { kind: "News", url: "https://arstechnica.com/" },
  { kind: "News", url: "https://www.aljazeera.com/" },

  { kind: "Shopping", url: "https://www.amazon.com/" },
  { kind: "Shopping", url: "https://www.ebay.com/" },
  { kind: "Shopping", url: "https://www.etsy.com/" },
  { kind: "Shopping", url: "https://www.ikea.com/us/en/" },
  { kind: "Shopping", url: "https://www.bestbuy.com/" },
  { kind: "Shopping", url: "https://www.walmart.com/" },
  { kind: "Shopping", url: "https://www.target.com/" },
  { kind: "Shopping", url: "https://www.apple.com/shop/buy-iphone" },
  { kind: "Shopping", url: "https://www.nike.com/" },
  { kind: "Shopping", url: "https://www.zara.com/us/" },

  { kind: "Code and forums", url: "https://github.com/microsoft/playwright" },
  { kind: "Code and forums", url: "https://news.ycombinator.com/" },
  { kind: "Code and forums", url: "https://stackoverflow.com/questions/tagged/javascript" },
  { kind: "Code and forums", url: "https://www.reddit.com/r/programming/" },
  { kind: "Code and forums", url: "https://www.npmjs.com/package/playwright" },
  { kind: "Code and forums", url: "https://dev.to/" },
  { kind: "Code and forums", url: "https://lobste.rs/" },
  { kind: "Code and forums", url: "https://gitlab.com/gitlab-org/gitlab" },
  { kind: "Code and forums", url: "https://huggingface.co/models" },
  { kind: "Code and forums", url: "https://www.producthunt.com/" },

  { kind: "Web apps", url: "https://vercel.com/" },
  { kind: "Web apps", url: "https://linear.app/" },
  { kind: "Web apps", url: "https://www.figma.com/" },
  { kind: "Web apps", url: "https://www.notion.com/" },
  { kind: "Web apps", url: "https://stripe.com/" },
  { kind: "Web apps", url: "https://www.airbnb.com/" },
  { kind: "Web apps", url: "https://www.booking.com/" },
  { kind: "Web apps", url: "https://www.twitch.tv/" },
  { kind: "Web apps", url: "https://discord.com/" },
  { kind: "Web apps", url: "https://open.spotify.com/" },

  { kind: "Plain info", url: "https://www.usa.gov/" },
  { kind: "Plain info", url: "https://www.gov.uk/" },
  { kind: "Plain info", url: "https://www.weather.gov/" },
  { kind: "Plain info", url: "https://archive.org/" },
  { kind: "Plain info", url: "https://arxiv.org/abs/1706.03762" },
  { kind: "Plain info", url: "https://www.imdb.com/" },
  { kind: "Plain info", url: "https://www.timeanddate.com/" },
  { kind: "Plain info", url: "https://www.britannica.com/" },
  { kind: "Plain info", url: "https://openai.com/" },
  { kind: "Plain info", url: "https://www.craigslist.org/about/sites" },
]
