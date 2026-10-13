/**
 * The 30 real sites the memory benchmark opens, in order: docs, code, papers,
 * and news front pages (the heavy ones, full of ads and trackers).
 *
 * Live sites change, so two runs on different days differ a little. Later
 * the benchmark replays a recorded copy so every run sees the same pages.
 *
 * Used by: run.ts
 */
export const SITES = [
  "https://en.wikipedia.org/wiki/Web_browser",
  "https://developer.mozilla.org/en-US/docs/Web/JavaScript",
  "https://news.ycombinator.com/",
  "https://github.com/microsoft/playwright",
  "https://stackoverflow.com/questions/tagged/javascript",
  "https://arxiv.org/abs/1706.03762",
  "https://www.bbc.com/news",
  "https://docs.python.org/3/",
  "https://react.dev/",
  "https://nodejs.org/en",
  "https://www.theverge.com/",
  "https://techcrunch.com/",
  "https://www.npmjs.com/package/playwright",
  "https://www.rust-lang.org/",
  "https://www.apple.com/",
  "https://edition.cnn.com/",
  "https://lightpanda.io/",
  "https://en.wikipedia.org/wiki/Zig_(programming_language)",
  "https://www.reuters.com/",
  "https://vercel.com/",
  "https://www.nytimes.com/",
  "https://www.youtube.com/",
  "https://www.amazon.com/",
  "https://www.reddit.com/r/programming/",
  "https://www.imdb.com/",
  "https://www.theguardian.com/international",
  "https://www.wired.com/",
  "https://openai.com/",
  "https://www.bloomberg.com/",
  "https://medium.com/",
]
