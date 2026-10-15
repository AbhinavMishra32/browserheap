// Runs before publishing (prepublishOnly). Stops `npm publish`: npm ignores
// package.json's publishConfig, so it would ship src/ as the entry point (not
// in the package) and drop the browserheap command. pnpm swaps in dist/.
const userAgent = process.env.npm_config_user_agent ?? ""
if (!userAgent.startsWith("pnpm")) {
  console.error("Publish with `pnpm publish`, not npm: npm ignores publishConfig and ships a broken package.")
  process.exit(1)
}
