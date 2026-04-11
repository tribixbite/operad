import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  site: "https://operad.stream",
  vite: {
    plugins: [tailwindcss()],
  },
});
