// open-next.config.ts
var config = {
  default: {
    // Use Cloudflare's edge runtime
    override: {
      wrapper: "cloudflare-node",
      converter: "edge",
      proxyExternalRequest: "fetch",
      // Use Cloudflare's cache API
      incrementalCache: "dummy",
      tagCache: "dummy",
      queue: "dummy"
    }
  },
  // External modules for edge runtime
  edgeExternals: ["node:crypto"],
  // Middleware configuration
  middleware: {
    external: true,
    override: {
      wrapper: "cloudflare-edge",
      converter: "edge",
      proxyExternalRequest: "fetch",
      incrementalCache: "dummy",
      tagCache: "dummy",
      queue: "dummy"
    }
  },
  // Dangerous options (use with caution)
  dangerous: {
    // Disable tag cache revalidation (not supported on Cloudflare)
    disableTagCache: true,
    // Disable incremental cache (use Cloudflare KV instead if needed)
    disableIncrementalCache: true
  }
};
var open_next_config_default = config;
export {
  open_next_config_default as default
};
