// @ts-check
import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";

// https://astro.build/config
export default defineConfig({
  output: "server",
  adapter: cloudflare({
    imageService: "compile",
  }),
  site: "https://nemar.org",
  trailingSlash: "ignore",
  experimental: {
    clientPrerender: true,
  },
  vite: {
    resolve: {
      // Workaround for Cloudflare Workers' lack of `Buffer` etc.
      alias: import.meta.env?.PROD
        ? { "react-dom/server": "react-dom/server.edge" }
        : undefined,
    },
  },
});
